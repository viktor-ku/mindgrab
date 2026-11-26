use super::*;

fn create(project: &mut Project, parent: Option<&str>, text: &str) -> String {
    project
        .apply(Command::CreateNode {
            parent: parent.map(String::from),
            index: None,
            text: text.into(),
            color: Color::BLUE,
            fill: None,
        })
        .unwrap()
        .created_node
        .unwrap()
}

fn text(project: &Project, id: &str) -> String {
    project
        .view()
        .unwrap()
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap()
        .text
}

#[test]
fn commands_own_order_colors_and_positions() {
    let mut project = Project::new("Mindgrab").unwrap();
    let root = create(&mut project, None, "root");
    let first = create(&mut project, Some(&root), "first");
    let second = create(&mut project, Some(&root), "second");
    project
        .apply(Command::MoveNode {
            id: second.clone(),
            parent: Some(root.clone()),
            index: 0,
        })
        .unwrap();
    project
        .apply(Command::SetColor {
            id: first.clone(),
            color: Color::TEAL,
        })
        .unwrap();
    project
        .apply(Command::SetPosition {
            id: first.clone(),
            position: Some(Position { x: 12.5, y: -4.0 }),
        })
        .unwrap();
    let view = project.view().unwrap();
    assert_eq!(view.legacy, None);
    assert_eq!(view.nodes[0].children, [second, first.clone()]);
    assert_eq!(view.nodes[2].color, Color::TEAL);
    assert_eq!(view.nodes[2].depth, 1);
    project
        .apply(Command::SetPosition {
            id: first,
            position: None,
        })
        .unwrap();
    assert_eq!(project.view().unwrap().nodes[2].position, None);
}

#[test]
fn concurrent_text_edits_merge_in_both_orders_and_duplicates_are_safe() {
    let mut seed = Project::new("Offline").unwrap();
    let id = create(&mut seed, None, "middle");
    let bytes = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&bytes).unwrap();
    let mut right = Project::from_snapshot(&bytes).unwrap();
    left.apply(Command::EditText {
        id: id.clone(),
        index: 0,
        delete_count: 0,
        insert: "left ".into(),
    })
    .unwrap();
    right
        .apply(Command::EditText {
            id: id.clone(),
            index: 6,
            delete_count: 0,
            insert: " right".into(),
        })
        .unwrap();
    let a = left.snapshot().unwrap();
    let b = right.snapshot().unwrap();
    left.merge(&b).unwrap();
    right.merge(&a).unwrap();
    left.merge(&b).unwrap();
    assert_eq!(text(&left, &id), "left middle right");
    assert_eq!(left.view().unwrap(), right.view().unwrap());
}

#[test]
fn conflicting_moves_converge_to_a_tree() {
    let mut seed = Project::new("Moves").unwrap();
    let a = create(&mut seed, None, "A");
    let b = create(&mut seed, None, "B");
    let snapshot = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&snapshot).unwrap();
    let mut right = Project::from_snapshot(&snapshot).unwrap();
    left.apply(Command::MoveNode {
        id: a.clone(),
        parent: Some(b.clone()),
        index: 0,
    })
    .unwrap();
    right
        .apply(Command::MoveNode {
            id: b,
            parent: Some(a),
            index: 0,
        })
        .unwrap();
    let l = left.snapshot().unwrap();
    let r = right.snapshot().unwrap();
    left.merge(&r).unwrap();
    right.merge(&l).unwrap();
    assert_eq!(left.view().unwrap(), right.view().unwrap());
    assert_eq!(left.view().unwrap().nodes.len(), 2);
    assert_eq!(left.view().unwrap().roots.len(), 1);
}

#[test]
fn concurrent_sibling_insertions_preserve_all_nodes_and_order() {
    let mut seed = Project::new("Order").unwrap();
    let root = create(&mut seed, None, "root");
    let snapshot = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&snapshot).unwrap();
    let mut right = Project::from_snapshot(&snapshot).unwrap();
    create(&mut left, Some(&root), "left");
    create(&mut right, Some(&root), "right");
    let l = left.snapshot().unwrap();
    let r = right.snapshot().unwrap();
    left.merge(&r).unwrap();
    right.merge(&l).unwrap();
    assert_eq!(left.view().unwrap(), right.view().unwrap());
    assert_eq!(left.view().unwrap().nodes[0].children.len(), 2);
}

#[test]
fn delete_hides_subtree_and_undo_restores_it() {
    let mut project = Project::new("Delete").unwrap();
    let root = create(&mut project, None, "root");
    create(&mut project, Some(&root), "child");
    project
        .apply(Command::DeleteNode {
            id: root,
            gap: None,
        })
        .unwrap();
    assert!(project.view().unwrap().nodes.is_empty());
    project.apply(Command::Undo).unwrap();
    assert_eq!(project.view().unwrap().nodes.len(), 2);
    project.apply(Command::Redo).unwrap();
    assert!(project.view().unwrap().nodes.is_empty());
}

#[test]
fn undo_keeps_remote_edits() {
    let mut seed = Project::new("Undo").unwrap();
    let id = create(&mut seed, None, "middle");
    let snapshot = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&snapshot).unwrap();
    let mut right = Project::from_snapshot(&snapshot).unwrap();
    left.apply(Command::EditText {
        id: id.clone(),
        index: 0,
        delete_count: 0,
        insert: "local ".into(),
    })
    .unwrap();
    right
        .apply(Command::EditText {
            id: id.clone(),
            index: 6,
            delete_count: 0,
            insert: " remote".into(),
        })
        .unwrap();
    left.merge(&right.snapshot().unwrap()).unwrap();
    left.apply(Command::Undo).unwrap();
    assert_eq!(text(&left, &id), "middle remote");
}

#[test]
fn rejected_remote_schema_does_not_poison_state_or_undo() {
    let mut project = Project::new("Trusted").unwrap();
    create(&mut project, None, "root");
    let before = project.view().unwrap();
    let rogue = LoroDoc::from_snapshot(&project.snapshot().unwrap()).unwrap();
    rogue.get_map("project").insert("name", " ").unwrap();
    rogue.commit();
    assert!(
        project
            .merge(&rogue.export(ExportMode::Snapshot).unwrap())
            .is_err()
    );
    assert_eq!(project.view().unwrap(), before);
    assert!(project.can_undo());
    project.apply(Command::Undo).unwrap();
    assert!(project.view().unwrap().nodes.is_empty());
}

#[test]
fn malformed_bytes_and_causal_gaps_are_rejected_atomically() {
    let mut seed = Project::new("Gaps").unwrap();
    let baseline = seed.snapshot().unwrap();
    let id = create(&mut seed, None, "dependency");
    let dependency = seed.snapshot().unwrap();
    let version = seed.version();
    seed.apply(Command::SetText {
        id,
        text: "dependent edit".into(),
    })
    .unwrap();
    let update = seed.updates_since(&version).unwrap();
    // A replica that holds the version takes only the new changes.
    assert!(update.len() < seed.snapshot().unwrap().len());
    let mut current = Project::from_snapshot(&dependency).unwrap();
    current.merge(&update).unwrap();
    assert_eq!(current.view().unwrap(), seed.view().unwrap());
    let mut replica = Project::from_snapshot(&baseline).unwrap();
    assert!(matches!(
        replica.merge(&update),
        Err(StateError::MissingDependencies)
    ));
    assert!(replica.merge(&[0, 1, 2]).is_err());
    assert!(replica.view().unwrap().nodes.is_empty());
    replica.merge(&seed.snapshot().unwrap()).unwrap();
    assert_eq!(replica.view().unwrap(), seed.view().unwrap());
}

fn note(project: &Project, id: &str) -> String {
    project
        .view()
        .unwrap()
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap()
        .note
}

#[test]
fn old_snapshots_and_note_cursors_remain_read_only_until_first_edit() {
    let mut project = Project::new("Old document").unwrap();
    let id = create(&mut project, None, "idea");
    // Nodes created before notes existed have no note entry; new nodes do.
    project
        .tree()
        .get_meta(project.node(&id).unwrap())
        .unwrap()
        .delete("note")
        .unwrap();
    project.doc.commit();
    let bytes = project.snapshot().unwrap();
    let mut restored = Project::from_snapshot(&bytes).unwrap();
    let version = restored.version();
    assert_eq!(note(&restored, &id), "");
    let cursor = restored.note_cursor(&id, 0, false).unwrap();
    assert_eq!(restored.resolve_note_cursor(&id, &cursor).unwrap(), 0);
    restored.note_cursor(&id, 0, true).unwrap();
    assert!(
        !restored
            .apply(Command::SetNote {
                id: id.clone(),
                note: "".into()
            })
            .unwrap()
            .changed
    );
    assert_eq!(restored.edit_note_draft(&id, &bytes, "", 0).unwrap(), 0);
    assert_eq!(restored.version(), version);
    assert!(
        restored
            .tree()
            .get_meta(restored.node(&id).unwrap())
            .unwrap()
            .get("note")
            .is_none()
    );
    assert!(!restored.can_undo());
    restored
        .edit_note_draft(&id, &bytes, "First 🌲 note", 13)
        .unwrap();
    assert_eq!(note(&restored, &id), "First 🌲 note");
    assert_eq!(text(&restored, &id), "idea");
}

#[test]
fn notes_set_edit_clear_and_round_trip_in_views() {
    let mut project = Project::new("Notes").unwrap();
    let id = create(&mut project, None, "idea");
    assert!(
        project
            .apply_json(
                &serde_json::json!({"type": "setNote", "id": id, "note": "a🦀b\nDetails"})
                    .to_string()
            )
            .unwrap()
            .changed
    );
    project.apply_json(&serde_json::json!({"type": "editNote", "id": id, "index": 1, "deleteCount": 2, "insert": "🌲"}).to_string()).unwrap();
    assert_eq!(note(&project, &id), "a🌲b\nDetails");
    assert_eq!(text(&project, &id), "idea");
    let restored = Project::from_snapshot(&project.snapshot().unwrap()).unwrap();
    assert_eq!(restored.view().unwrap(), project.view().unwrap());
    assert!(
        !project
            .apply(Command::SetNote {
                id: id.clone(),
                note: "a🌲b\nDetails".into()
            })
            .unwrap()
            .changed
    );
    project
        .apply(Command::SetNote {
            id: id.clone(),
            note: "".into(),
        })
        .unwrap();
    assert_eq!(note(&project, &id), "");
    assert!(
        project
            .tree()
            .get_meta(project.node(&id).unwrap())
            .unwrap()
            .get("note")
            .is_some()
    );
    assert!(
        project
            .apply_json(
                &serde_json::json!({"type": "setNote", "id": id, "note": "", "extra": true})
                    .to_string()
            )
            .is_err()
    );
    assert!(project.apply_json(&serde_json::json!({"type": "editNote", "id": id, "index": 0, "delete_count": 0, "insert": ""}).to_string()).is_err());
}

#[test]
fn concurrent_first_note_edits_preserve_both_and_local_undo_keeps_remote_note() {
    let mut seed = Project::new("Lazy notes").unwrap();
    let id = create(&mut seed, None, "idea");
    let bytes = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&bytes).unwrap();
    let mut right = Project::from_snapshot(&bytes).unwrap();
    left.apply(Command::SetNote {
        id: id.clone(),
        note: "local".into(),
    })
    .unwrap();
    right
        .apply(Command::EditNote {
            id: id.clone(),
            index: 0,
            delete_count: 0,
            insert: "remote".into(),
        })
        .unwrap();
    let a = left.snapshot().unwrap();
    let b = right.snapshot().unwrap();
    left.merge(&b).unwrap();
    right.merge(&a).unwrap();
    left.merge(&b).unwrap();
    assert_eq!(left.view().unwrap(), right.view().unwrap());
    let merged = note(&left, &id);
    assert!(merged == "localremote" || merged == "remotelocal");
    left.apply(Command::Undo).unwrap();
    assert_eq!(note(&left, &id), "remote");
    left.apply(Command::Redo).unwrap();
    assert_eq!(note(&left, &id), merged);
}

#[test]
fn undoing_a_move_of_a_remotely_deleted_node_leaves_no_blank_idea() {
    // Loro recreates a deleted node without its data when undo moves it back.
    for delete_moved in [false, true] {
        let mut r0 = Project::new("Concurrent").unwrap();
        let a = create(&mut r0, None, "a");
        let b = create(&mut r0, None, "b");
        r0.clear_history();
        let mut r1 = Project::from_snapshot(&r0.snapshot().unwrap()).unwrap();
        r0.start_group().unwrap();
        r0.apply(Command::MoveNode {
            id: a.clone(),
            parent: Some(b.clone()),
            index: 0,
        })
        .unwrap();
        r0.stop_group();
        r0.start_group().unwrap();
        r1.merge(&r0.snapshot().unwrap()).unwrap();
        let deleted = if delete_moved { a.clone() } else { b.clone() };
        r1.apply(Command::DeleteNode {
            id: deleted,
            gap: None,
        })
        .unwrap();
        r0.merge(&r1.snapshot().unwrap()).unwrap();
        r0.apply(Command::Undo).unwrap();
        let view = r0.view().unwrap();
        assert!(view.nodes.iter().all(|node| !node.text.is_empty()));
        r1.merge(&r0.snapshot().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(r1.view().unwrap()).unwrap(),
            serde_json::to_value(view).unwrap()
        );
    }
}

/// Every op in the document's history and its whole state, including deleted
/// tree nodes and their metadata, as text.
fn everything(bytes: &[u8]) -> String {
    let doc = LoroDoc::new();
    doc.import(bytes).unwrap();
    let history =
        serde_json::to_string(&doc.export_json_updates(&Default::default(), &doc.oplog_vv()))
            .unwrap();
    let tree = doc.get_tree("nodes");
    let metas: Vec<_> = tree
        .nodes()
        .into_iter()
        .map(|id| tree.get_meta(id).unwrap().get_deep_value().to_json_value())
        .collect();
    format!(
        "{history}{}{}",
        doc.get_deep_value().to_json_value(),
        serde_json::Value::from(metas)
    )
}

#[test]
fn share_snapshots_hold_only_the_current_map() {
    let mut project = Project::new("Canary draft").unwrap();
    let root = create(&mut project, None, "root");
    let child = create(&mut project, Some(&root), "kept");
    let gone = create(&mut project, Some(&root), "Canary idea");
    let below = create(&mut project, Some(&gone), "Canary child");
    for (id, note) in [
        (&gone, "Canary note"),
        (&below, "Canary note below"),
        (&root, "kept Canary edit"),
    ] {
        project
            .apply(Command::SetNote {
                id: id.clone(),
                note: note.into(),
            })
            .unwrap();
    }
    project
        .apply(Command::SetNote {
            id: root.clone(),
            note: "kept".into(),
        })
        .unwrap();
    project
        .apply(Command::SetText {
            id: child.clone(),
            text: "kept Canary text".into(),
        })
        .unwrap();
    project
        .apply(Command::SetText {
            id: child.clone(),
            text: "kept".into(),
        })
        .unwrap();
    project
        .apply(Command::DeleteNode {
            id: gone,
            gap: Some(40.0),
        })
        .unwrap();
    project
        .apply(Command::SetPosition {
            id: child.clone(),
            position: Some(Position { x: 3.0, y: 4.0 }),
        })
        .unwrap();
    project
        .apply(Command::Rename {
            name: "Plan".into(),
        })
        .unwrap();

    // The owner's snapshot keeps everything, so the check below can see it.
    assert!(everything(&project.snapshot().unwrap()).contains("Canary"));
    let shared = project.share_snapshot().unwrap();
    assert!(!everything(&shared).contains("Canary"));
    assert!(!shared.windows(6).any(|window| window == b"Canary"));
    // Viewers see the same map, with the same node IDs.
    assert_eq!(
        Project::from_snapshot(&shared).unwrap().view().unwrap(),
        project.view().unwrap()
    );
}

#[test]
fn older_maps_report_their_colors_and_links_until_forgotten() {
    let mut project = Project::new("Older").unwrap();
    create(&mut project, None, "root");
    let older = LoroDoc::from_snapshot(&project.snapshot().unwrap()).unwrap();
    let meta = older.get_map("project");
    meta.insert(
        "colors",
        loro::LoroValue::from(
            serde_json::json!({"quick": ["sky-400", "slate"], "newIdeas": "lime-200"}),
        ),
    )
    .unwrap();
    meta.insert("links", "square").unwrap();
    meta.insert(
        "saving",
        loro::LoroValue::from(serde_json::json!({"local": false, "cloud": true})),
    )
    .unwrap();
    older.commit();
    let mut project = Project::from_snapshot(&older.export(ExportMode::Snapshot).unwrap()).unwrap();
    // Viewers of a share link see the lines the owner chose, and nothing else
    // the map kept.
    let shared = Project::from_snapshot(&project.share_snapshot().unwrap()).unwrap();
    assert_eq!(
        shared.view().unwrap().legacy,
        Some(LegacyPreferences {
            colors: None,
            links: Some(LinkStyle::Square),
        })
    );
    assert_eq!(
        project.view().unwrap().legacy,
        Some(LegacyPreferences {
            colors: Some(ColorPreferences {
                quick: vec![Color::shade("sky", 400).unwrap(), Color::SLATE],
                new_ideas: Color::shade("lime", 200).unwrap(),
            }),
            links: Some(LinkStyle::Square),
        })
    );
    let forgotten = project.apply(Command::ForgetLegacyPreferences).unwrap();
    assert!(forgotten.changed);
    assert_eq!(project.view().unwrap().legacy, None);
    let shared = Project::from_snapshot(&project.share_snapshot().unwrap()).unwrap();
    assert_eq!(shared.view().unwrap().legacy, None);
    // Forgetting is not an edit, so undo has nothing to bring back.
    assert!(!project.can_undo());
    assert!(
        !project
            .apply(Command::ForgetLegacyPreferences)
            .unwrap()
            .changed
    );
}

#[test]
fn preferences_are_typed_by_name_and_checked() {
    let row: PreferenceRow = serde_json::from_value(serde_json::json!({
        "scope": "map",
        "projectId": "6f1c2a1e-3b0a-4c55-9a6e-2f2c3c0f9b11",
        "name": "linkStyle",
        "value": "freeform",
    }))
    .unwrap();
    assert_eq!(row.preference, Preference::LinkStyle(LinkStyle::Freeform));
    assert!(row.validate().is_ok());
    assert_eq!(
        serde_json::to_value(&row).unwrap()["value"],
        serde_json::json!("freeform")
    );
    // A value of the wrong type for its name does not parse.
    assert!(
        serde_json::from_value::<Preference>(serde_json::json!({
            "name": "linkStyle",
            "value": ["slate"],
        }))
        .is_err()
    );
    // Only white and shades are offered, each once.
    let repeated = Preference::QuickColors(vec![Color::SLATE, Color::SLATE]);
    assert!(repeated.validate().is_err());
    assert!(Preference::NewIdeaColor(Color::TEAL).validate().is_err());
    // A global preference names no map, and a map preference names its map.
    let global = PreferenceTarget {
        scope: PreferenceScope::Global,
        project_id: Some("map".into()),
        name: PreferenceName::LinkStyle,
    };
    assert!(global.validate().is_err());
    let map = PreferenceTarget {
        scope: PreferenceScope::Map,
        project_id: None,
        name: PreferenceName::LinkStyle,
    };
    assert!(map.validate().is_err());
}

#[test]
fn where_older_maps_were_saved_is_only_forgotten() {
    let project = Project::new("Older").unwrap();
    let older = LoroDoc::from_snapshot(&project.snapshot().unwrap()).unwrap();
    older
        .get_map("project")
        .insert(
            "saving",
            loro::LoroValue::from(serde_json::json!({"local": true, "cloud": true})),
        )
        .unwrap();
    older.commit();
    let mut project = Project::from_snapshot(&older.export(ExportMode::Snapshot).unwrap()).unwrap();
    // Nothing to adopt, but still something to forget.
    assert_eq!(
        project.view().unwrap().legacy,
        Some(LegacyPreferences {
            colors: None,
            links: None
        })
    );
    assert!(
        project
            .apply(Command::ForgetLegacyPreferences)
            .unwrap()
            .changed
    );
    assert_eq!(project.view().unwrap().legacy, None);
    // A damaged one is still refused.
    let damaged = LoroDoc::from_snapshot(&project.snapshot().unwrap()).unwrap();
    damaged
        .get_map("project")
        .insert("saving", "everywhere")
        .unwrap();
    damaged.commit();
    assert!(Project::from_snapshot(&damaged.export(ExportMode::Snapshot).unwrap()).is_err());
}

#[test]
fn consent_is_set_for_all_maps_only() {
    let row: PreferenceRow = serde_json::from_value(serde_json::json!({
        "scope": "map",
        "projectId": "6f1c2a1e-3b0a-4c55-9a6e-2f2c3c0f9b11",
        "name": "analyticsConsent",
        "value": "granted",
    }))
    .unwrap();
    assert!(row.validate().is_err());
    let global = PreferenceRow {
        scope: PreferenceScope::Global,
        project_id: None,
        ..row
    };
    assert!(global.validate().is_ok());
    for (name, value) in [("saveLocally", false), ("saveInCloud", true)] {
        let row: PreferenceRow = serde_json::from_value(serde_json::json!({
            "scope": "map",
            "projectId": "6f1c2a1e-3b0a-4c55-9a6e-2f2c3c0f9b11",
            "name": name,
            "value": value,
        }))
        .unwrap();
        assert!(row.validate().is_ok());
    }
}

fn type_at_start(project: &mut Project, id: &str, insert: &str) {
    project
        .apply(Command::EditText {
            id: id.into(),
            index: 0,
            delete_count: 0,
            insert: insert.into(),
        })
        .unwrap();
}

/// The peers a head names, in the order it names them.
fn head_peers(head: &str) -> Vec<u64> {
    head.split(',')
        .map(|id| id.split_once('@').unwrap().1.parse().unwrap())
        .collect()
}

#[test]
fn a_head_names_the_version_of_the_replica_it_came_from() {
    let mut seed = Project::new("Heads").unwrap();
    let id = create(&mut seed, None, "middle");
    let bytes = seed.snapshot().unwrap();
    let (seed_head, seed_version) = (seed.head().unwrap(), seed.version());
    assert_eq!(seed.version_at(&seed_head), Some(seed_version.clone()));

    let mut left = Project::from_snapshot(&bytes).unwrap();
    let mut right = Project::from_snapshot(&bytes).unwrap();
    // A copy names the same version the same way.
    assert_eq!(left.head(), Some(seed_head.clone()));
    type_at_start(&mut left, &id, "left ");
    type_at_start(&mut right, &id, "right ");
    let (left_head, left_version) = (left.head().unwrap(), left.version());
    let (right_head, right_version) = (right.head().unwrap(), right.version());
    // Neither holds the other's edit yet.
    assert_eq!(left.version_at(&right_head), None);
    assert_eq!(right.version_at(&left_head), None);
    assert_eq!(seed.version_at(&left_head), None);

    left.merge(&right.snapshot().unwrap()).unwrap();
    right.merge(&left.snapshot().unwrap()).unwrap();
    // Two edits made apart are both the latest: one id each, sorted by peer.
    let head = left.head().unwrap();
    assert_eq!(right.head(), Some(head.clone()));
    let peers = head_peers(&head);
    assert_eq!(peers.len(), 2);
    assert!(peers[0] < peers[1]);
    assert_eq!(head.len(), left_head.len() + 1 + right_head.len());
    for project in [&left, &right] {
        assert_eq!(project.version_at(&head), Some(project.version()));
        // Earlier heads still name the versions they named then.
        assert_eq!(project.version_at(&seed_head), Some(seed_version.clone()));
        assert_eq!(project.version_at(&left_head), Some(left_version.clone()));
        assert_eq!(project.version_at(&right_head), Some(right_version.clone()));
    }
    // Ids in another order, or with one they already cover, name it too.
    let (first, second) = head.split_once(',').unwrap();
    for same in [
        format!("{second},{first}"),
        format!("{head},{seed_head}"),
        format!("{left_head},{head}"),
    ] {
        assert_eq!(left.version_at(&same), Some(left.version()));
    }

    type_at_start(&mut left, &id, "later ");
    // One edit on top of both is the only latest change again.
    assert_eq!(head_peers(&left.head().unwrap()).len(), 1);
    assert_eq!(left.version_at(&head), Some(right.version()));
    assert_eq!(left.version_at(&left.head().unwrap()), Some(left.version()));
    assert_eq!(right.version_at(&left.head().unwrap()), None);
}

#[test]
fn heads_a_document_cannot_answer_are_refused_without_harm() {
    let mut project = Project::new("Refused").unwrap();
    let id = create(&mut project, None, "idea");
    let head = project.head().unwrap();
    let (counter, peer) = head.split_once('@').unwrap();
    let counter: i32 = counter.parse().unwrap();
    let refused = [
        String::new(),
        // A peer that never edited this document, and a change not made yet.
        "0@77".into(),
        format!("{}@{peer}", counter + 1),
        format!("{}@{peer}", i32::MAX),
        format!("{head},0@77"),
        // Signs, and numbers past what a counter or a peer can be.
        format!("-1@{peer}"),
        format!("-0@{peer}"),
        format!("-{counter}@{peer}"),
        format!("+{counter}@{peer}"),
        format!("{counter}@+{peer}"),
        format!("{counter}@-{peer}"),
        format!("2147483648@{peer}"),
        format!("{counter}@18446744073709551616"),
        // Anything but digits around one @, joined by single commas.
        "garbage".into(),
        "@".into(),
        ",".into(),
        format!("{counter}@"),
        format!("@{peer}"),
        format!("{counter}{peer}"),
        format!("{counter}@{peer}@{peer}"),
        format!("{head},"),
        format!(",{head}"),
        format!("{head},,{head}"),
        format!(" {head}"),
        format!("{head} "),
        format!("{head}\n"),
        format!("{counter} @{peer}"),
        format!("{head}, {head}"),
        format!("0x{counter}@{peer}"),
        format!("{counter}.0@{peer}"),
        format!("{counter}e0@{peer}"),
        format!("١@{peer}"),
        format!("{peer}:{counter}"),
        String::from_utf8(project.version()).unwrap(),
    ];
    for head in &refused {
        assert_eq!(project.version_at(head), None, "{head:?}");
    }
    // A head may repeat an id, up to the size limit and no further.
    let repeat = |times: usize| vec![head.as_str(); times].join(",");
    let fits = (MAX_HEAD_BYTES + 1) / (head.len() + 1);
    assert!(repeat(fits).len() <= MAX_HEAD_BYTES);
    assert!(repeat(fits + 1).len() > MAX_HEAD_BYTES);
    assert_eq!(project.version_at(&repeat(fits)), Some(project.version()));
    assert_eq!(project.version_at(&repeat(fits + 1)), None);
    assert_eq!(project.version_at(&"1".repeat(MAX_HEAD_BYTES + 1)), None);

    // A stored snapshot answers each of them with the whole document.
    let snapshot = project.snapshot().unwrap();
    for since in refused.iter().cloned().chain([repeat(fits + 1)]) {
        let sent = outgoing(&snapshot, &since).unwrap();
        assert_eq!(sent.head, Some(head.clone()), "{since:?}");
        assert_eq!(sent.updates, None, "{since:?}");
    }

    // None of it left the document unable to answer or to edit.
    assert_eq!(project.head(), Some(head.clone()));
    assert_eq!(project.version_at(&head), Some(project.version()));
    type_at_start(&mut project, &id, "an ");
    assert_eq!(text(&project, &id), "an idea");
    let next = project.head().unwrap();
    assert_ne!(next, head);
    assert_eq!(project.version_at(&next), Some(project.version()));
    assert_eq!(
        Project::from_snapshot(&project.snapshot().unwrap())
            .unwrap()
            .view()
            .unwrap(),
        project.view().unwrap()
    );
}

#[test]
fn a_stored_snapshot_sends_a_replica_only_what_it_lacks() {
    let mut project = Project::new("Outgoing").unwrap();
    let id = create(&mut project, None, "idea");
    project
        .apply(Command::SetNote {
            id: id.clone(),
            note: "a note long enough to outweigh one typed letter. ".repeat(40),
        })
        .unwrap();
    let old = project.snapshot().unwrap();
    let old_head = project.head().unwrap();
    type_at_start(&mut project, &id, "x");
    let snapshot = project.snapshot().unwrap();
    let head = project.head().unwrap();

    // A replica at the stored head lacks nothing.
    let sent = outgoing(&snapshot, &head).unwrap();
    assert_eq!(sent.head, Some(head.clone()));
    assert_eq!(sent.updates, Some(Vec::new()));
    // The same version named another way lacks nothing either.
    let sent = outgoing(&snapshot, &format!("{old_head},{head}")).unwrap();
    assert_eq!(sent.head, Some(head.clone()));
    assert_eq!(sent.updates, Some(Vec::new()));

    // A replica at an older head gets the changes since, not the document.
    let sent = outgoing(&snapshot, &old_head).unwrap();
    assert_eq!(sent.head, Some(head.clone()));
    let update = sent.updates.unwrap();
    assert!(!update.is_empty());
    assert!(update.len() * 10 < snapshot.len());
    let mut replica = Project::from_snapshot(&old).unwrap();
    replica.merge(&update).unwrap();
    assert_eq!(replica.version(), project.version());
    assert_eq!(replica.head(), Some(head.clone()));
    assert_eq!(replica.view().unwrap(), project.view().unwrap());

    // A replica that holds nothing, or changes the stored document lacks,
    // gets the complete snapshot.
    type_at_start(&mut replica, &id, "y");
    for since in [String::new(), replica.head().unwrap()] {
        let sent = outgoing(&snapshot, &since).unwrap();
        assert_eq!(sent.head, Some(head.clone()));
        assert_eq!(sent.updates, None);
    }
    // Bytes that are not a whole document are an error, not an answer.
    assert!(outgoing(&[0, 1, 2], &head).is_err());
    assert!(matches!(
        outgoing(&update, &head),
        Err(StateError::MissingDependencies)
    ));
    assert!(matches!(
        outgoing(&vec![0; MAX_SNAPSHOT_BYTES + 1], &head),
        Err(StateError::ResourceLimit)
    ));
}

#[test]
fn a_document_with_too_many_latest_changes_has_no_head() {
    let mut hub = Project::new("Wide").unwrap();
    let root = create(&mut hub, None, "root");
    let seed = hub.snapshot().unwrap();
    let (seed_head, seed_version) = (hub.head().unwrap(), hub.version());
    // 200 replicas each add an idea without seeing the others.
    let apart: Vec<_> = (0..200u64)
        .map(|replica| {
            let mut project = Project::from_snapshot(&seed).unwrap();
            // The longest peer ids there are, so the size does not vary by run.
            project.doc.set_peer_id(u64::MAX - 1 - replica).unwrap();
            create(&mut project, Some(&root), "idea");
            project.updates_since(&seed_version).unwrap()
        })
        .collect();

    // 150 ids still fit. They name the version in any order.
    hub.doc.import_batch(&apart[..150]).unwrap();
    let head = hub.head().unwrap();
    assert!(head.len() <= MAX_HEAD_BYTES);
    assert_eq!(head_peers(&head).len(), 150);
    assert!(head_peers(&head).is_sorted());
    let version = hub.version();
    assert_eq!(hub.version_at(&head), Some(version.clone()));
    let reversed: Vec<_> = head.split(',').rev().collect();
    assert_eq!(hub.version_at(&reversed.join(",")), Some(version.clone()));
    let earlier = hub.snapshot().unwrap();

    hub.doc.import_batch(&apart[150..]).unwrap();
    assert_eq!(hub.view().unwrap().nodes.len(), 201);
    assert_eq!(hub.head(), None);
    let ids: Vec<_> = hub
        .doc
        .oplog_frontiers()
        .iter()
        .map(|id| format!("{}@{}", id.counter, id.peer))
        .collect();
    assert_eq!(ids.len(), 200);
    // Too long to be a head, though every id in it is held.
    assert!(ids.join(",").len() > MAX_HEAD_BYTES);
    assert_eq!(hub.version_at(&ids.join(",")), None);
    assert!(hub.version_at(&ids[0]).is_some());
    // Earlier heads are still answered, but nothing can be sent against a
    // head that cannot be named.
    assert_eq!(hub.version_at(&head), Some(version));
    assert_eq!(hub.version_at(&seed_head), Some(seed_version));
    let snapshot = hub.snapshot().unwrap();
    for since in [head.as_str(), seed_head.as_str(), ""] {
        let sent = outgoing(&snapshot, since).unwrap();
        assert_eq!(sent.head, None);
        assert_eq!(sent.updates, None);
    }
    // The document as it was 50 changes earlier still names its head.
    let sent = outgoing(&earlier, &head).unwrap();
    assert_eq!(sent.head, Some(head));
    assert_eq!(sent.updates, Some(Vec::new()));
}

/// A small generator with a fixed sequence per seed, so a failure repeats.
struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }
}

fn edit_at_random(project: &mut Project, random: &mut Random) {
    let nodes = project.view().unwrap().nodes;
    if nodes.is_empty() || random.below(5) == 0 {
        let parent = (!nodes.is_empty()).then(|| nodes[random.below(nodes.len())].id.clone());
        create(project, parent.as_deref(), "idea");
        return;
    }
    let id = nodes[random.below(nodes.len())].id.clone();
    let words = "word ".repeat(random.below(60));
    let command = match random.below(5) {
        0 => Command::DeleteNode { id, gap: None },
        1 => Command::SetText { id, text: words },
        2 => Command::SetNote { id, note: words },
        3 => Command::SetColor {
            id,
            color: Color::TEAL,
        },
        _ => Command::EditText {
            id,
            index: 0,
            delete_count: 0,
            insert: words,
        },
    };
    project.apply(command).unwrap();
}

#[test]
fn updates_sent_for_random_histories_are_smaller_than_the_snapshot_and_complete() {
    for seed in 1..=12u64 {
        let mut random = Random(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut project = Project::new("Random").unwrap();
        let mut other = Project::from_snapshot(&project.snapshot().unwrap()).unwrap();
        // Heads the document passed through, each with the document then.
        let mut passed = vec![(project.head().unwrap(), project.snapshot().unwrap())];
        for _ in 0..10 + random.below(50) {
            match random.below(8) {
                0 | 1 => edit_at_random(&mut other, &mut random),
                2 => {
                    project.merge(&other.snapshot().unwrap()).unwrap();
                    other.merge(&project.snapshot().unwrap()).unwrap();
                }
                _ => edit_at_random(&mut project, &mut random),
            }
            if random.below(2) == 0 {
                passed.push((project.head().unwrap(), project.snapshot().unwrap()));
            }
        }
        let snapshot = project.snapshot().unwrap();
        for (head, held) in passed {
            let mut replica = Project::from_snapshot(&held).unwrap();
            let version = project.version_at(&head).unwrap();
            assert_eq!(replica.version(), version);
            let sent = outgoing(&snapshot, &head).unwrap();
            assert_eq!(sent.head, project.head());
            let Some(update) = sent.updates else {
                // Only because the changes would be no smaller.
                assert!(project.updates_since(&version).unwrap().len() >= snapshot.len());
                continue;
            };
            assert!(update.len() < snapshot.len());
            assert_eq!(update.is_empty(), version == project.version());
            if !update.is_empty() {
                replica.merge(&update).unwrap();
            }
            assert_eq!(replica.version(), project.version());
            assert_eq!(replica.view().unwrap(), project.view().unwrap());
        }
    }
}

#[test]
fn heads_hold_through_hundreds_of_rounds_of_two_replicas_editing_apart() {
    let mut left = Project::new("Rounds").unwrap();
    let id = create(&mut left, None, "");
    let mut right = Project::from_snapshot(&left.snapshot().unwrap()).unwrap();
    let mut earlier = Vec::new();
    for round in 0..200 {
        type_at_start(&mut left, &id, "l");
        type_at_start(&mut right, &id, "r");
        let (left_head, left_version) = (left.head().unwrap(), left.version());
        let (right_head, right_version) = (right.head().unwrap(), right.version());
        assert_eq!(left.version_at(&left_head), Some(left_version.clone()));
        assert_eq!(left.version_at(&right_head), None);
        let (from_left, from_right) = (left.snapshot().unwrap(), right.snapshot().unwrap());
        left.merge(&from_right).unwrap();
        right.merge(&from_left).unwrap();
        // Both typed apart, so the version is named by one id from each.
        let head = left.head().unwrap();
        assert_eq!(right.head(), Some(head.clone()));
        assert_eq!(head_peers(&head).len(), 2);
        for project in [&left, &right] {
            assert_eq!(project.version_at(&head), Some(project.version()));
            assert_eq!(project.version_at(&left_head), Some(left_version.clone()));
            assert_eq!(project.version_at(&right_head), Some(right_version.clone()));
        }
        if round % 40 == 0 {
            earlier.push((round, head, left.version(), left.snapshot().unwrap()));
        }
    }
    assert_eq!(text(&left, &id).len(), 400);
    let snapshot = left.snapshot().unwrap();
    let head = left.head().unwrap();
    assert_eq!(
        outgoing(&snapshot, &head).unwrap().updates,
        Some(Vec::new())
    );
    // The first of these is far enough behind to be sent the snapshot, and
    // the last is not.
    for (round, since, version, held) in earlier {
        // A head from hundreds of rounds back still names its version.
        assert_eq!(right.version_at(&since), Some(version.clone()));
        let sent = outgoing(&snapshot, &since).unwrap();
        assert_eq!(sent.head, Some(head.clone()));
        let Some(update) = sent.updates else {
            // The snapshot packs a long history tighter than its changes.
            assert!(left.updates_since(&version).unwrap().len() >= snapshot.len());
            assert_ne!(round, 160);
            continue;
        };
        assert_ne!(round, 0);
        assert!(!update.is_empty());
        assert!(update.len() < snapshot.len());
        let mut replica = Project::from_snapshot(&held).unwrap();
        assert_eq!(replica.version(), version);
        replica.merge(&update).unwrap();
        assert_eq!(replica.version(), left.version());
        assert_eq!(replica.view().unwrap(), left.view().unwrap());
    }
}
