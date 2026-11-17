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
fn commands_own_order_colors_positions_and_preferences() {
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
    project
        .apply(Command::SetSaving {
            local: false,
            cloud: true,
        })
        .unwrap();
    assert_eq!(project.view().unwrap().links, LinkStyle::Rounded);
    project
        .apply(Command::SetLinks {
            style: LinkStyle::Square,
        })
        .unwrap();
    let view = project.view().unwrap();
    assert_eq!(view.links, LinkStyle::Square);
    assert_eq!(view.nodes[0].children, [second, first.clone()]);
    assert_eq!(view.nodes[2].color, Color::TEAL);
    assert_eq!(view.nodes[2].depth, 1);
    assert_eq!(
        view.saving,
        SavingPreferences {
            local: false,
            cloud: true
        }
    );
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
fn undo_keeps_remote_edits_and_privacy_preferences() {
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
    left.apply(Command::SetSaving {
        local: false,
        cloud: false,
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
    assert_eq!(
        left.view().unwrap().saving,
        SavingPreferences {
            local: false,
            cloud: false
        }
    );
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
    let version = seed.doc.oplog_vv();
    seed.apply(Command::SetText {
        id,
        text: "dependent edit".into(),
    })
    .unwrap();
    let update = seed
        .doc
        .export(ExportMode::Updates {
            from: std::borrow::Cow::Borrowed(&version),
        })
        .unwrap();
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
