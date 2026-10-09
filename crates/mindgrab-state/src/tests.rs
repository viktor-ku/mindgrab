use super::*;

fn create(project: &mut Project, parent: Option<&str>, text: &str) -> String {
    project
        .apply(Command::CreateNode {
            parent: parent.map(String::from),
            index: None,
            text: text.into(),
            color: Color::Blue,
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
fn empty_document_round_trips_without_initialization_on_open() {
    let project = Project::new("Mindgrab").unwrap();
    let restored = Project::from_snapshot(&project.snapshot().unwrap()).unwrap();
    assert_eq!(restored.view().unwrap(), project.view().unwrap());
    assert!(!restored.can_undo());
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
            color: Color::Teal,
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
    let view = project.view().unwrap();
    assert_eq!(view.nodes[0].children, [second, first.clone()]);
    assert_eq!(view.nodes[2].color, Color::Teal);
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
fn utf16_edits_reject_split_surrogates_without_partial_changes() {
    let mut project = Project::new("Unicode").unwrap();
    let id = create(&mut project, None, "a🦀b");
    assert!(
        project
            .apply(Command::EditText {
                id: id.clone(),
                index: 2,
                delete_count: 0,
                insert: "bad".into()
            })
            .is_err()
    );
    assert_eq!(text(&project, &id), "a🦀b");
    project
        .apply(Command::EditText {
            id: id.clone(),
            index: 1,
            delete_count: 2,
            insert: "🌲".into(),
        })
        .unwrap();
    project
        .apply(Command::SetText {
            id: id.clone(),
            text: "a🌲b café".into(),
        })
        .unwrap();
    assert_eq!(text(&project, &id), "a🌲b café");
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
    project.apply(Command::DeleteNode { id: root }).unwrap();
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
fn invalid_commands_do_not_change_state() {
    let mut project = Project::new("Validation").unwrap();
    let root = create(&mut project, None, "root");
    let child = create(&mut project, Some(&root), "child");
    let before = project.view().unwrap();
    for command in [
        Command::Rename { name: "  ".into() },
        Command::MoveNode {
            id: root.clone(),
            parent: Some(child),
            index: 0,
        },
        Command::CreateNode {
            parent: None,
            index: Some(10),
            text: "invalid".into(),
            color: Color::Blue,
        },
        Command::SetPosition {
            id: root.clone(),
            position: Some(Position {
                x: f64::NAN,
                y: 0.0,
            }),
        },
        Command::SetText {
            id: root,
            text: "x".repeat(MAX_TEXT_UTF16 + 1),
        },
    ] {
        assert!(project.apply(command).is_err());
        assert_eq!(project.view().unwrap(), before);
    }
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
fn hidden_node_data_is_validated_and_extra_roots_are_rejected() {
    let mut seed = Project::new("Schema").unwrap();
    let id = create(&mut seed, None, "root");
    let raw = LoroDoc::from_snapshot(&seed.snapshot().unwrap()).unwrap();
    let tree = raw.get_tree("nodes");
    let node = TreeID::try_from(id.as_str()).unwrap();
    tree.get_meta(node)
        .unwrap()
        .insert("color", "invalid")
        .unwrap();
    tree.delete(node).unwrap();
    raw.commit();
    assert!(Project::from_snapshot(&raw.export(ExportMode::Snapshot).unwrap()).is_err());
    let raw = LoroDoc::from_snapshot(&seed.snapshot().unwrap()).unwrap();
    raw.get_map("unexpected").insert("value", true).unwrap();
    raw.commit();
    assert!(Project::from_snapshot(&raw.export(ExportMode::Snapshot).unwrap()).is_err());
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

#[test]
fn grouped_delete_undo_preserves_application_identity_after_replication() {
    let mut local = Project::new("Identity").unwrap();
    let root = create(&mut local, None, "root");
    let mut local = Project::from_snapshot(&local.snapshot().unwrap()).unwrap();
    local.start_group().unwrap();
    let child = create(&mut local, Some(&root), "");
    local.stop_group();
    local.start_group().unwrap();
    local
        .apply(Command::SetText {
            id: child.clone(),
            text: "Added 🌲".into(),
        })
        .unwrap();
    local.stop_group();
    let mut remote = Project::from_snapshot(&local.snapshot().unwrap()).unwrap();
    local.start_group().unwrap();
    local
        .apply(Command::DeleteNode { id: child.clone() })
        .unwrap();
    local.stop_group();
    remote.merge(&local.snapshot().unwrap()).unwrap();
    local.apply(Command::Undo).unwrap();
    let restored = local
        .view()
        .unwrap()
        .nodes
        .into_iter()
        .find(|node| node.id == child)
        .unwrap();
    assert_eq!(restored.text, "Added 🌲");
    remote.merge(&local.snapshot().unwrap()).unwrap();
    assert_eq!(remote.view().unwrap(), local.view().unwrap());
}

#[test]
fn concurrent_delete_undo_projects_one_stable_application_node() {
    let mut seed = Project::new("Concurrent undo").unwrap();
    let root = create(&mut seed, None, "root");
    let bytes = seed.snapshot().unwrap();
    let mut a = Project::from_snapshot(&bytes).unwrap();
    let mut b = Project::from_snapshot(&bytes).unwrap();
    a.apply(Command::DeleteNode { id: root.clone() }).unwrap();
    b.apply(Command::DeleteNode { id: root.clone() }).unwrap();
    a.apply(Command::Undo).unwrap();
    b.apply(Command::Undo).unwrap();
    let a_bytes = a.snapshot().unwrap();
    let b_bytes = b.snapshot().unwrap();
    a.merge(&b_bytes).unwrap();
    b.merge(&a_bytes).unwrap();
    assert_eq!(a.view().unwrap(), b.view().unwrap());
    assert_eq!(a.view().unwrap().roots, vec![root]);
    assert_eq!(a.view().unwrap().nodes.len(), 1);
}

#[test]
fn stable_cursors_and_ime_drafts_use_utf16_on_both_targets() {
    let mut project = Project::new("Cursors").unwrap();
    let id = create(&mut project, None, "Hello 🌲");
    let before = project.cursor(&id, 6, false).unwrap();
    let after = project.cursor(&id, 6, true).unwrap();
    project
        .apply(Command::EditText {
            id: id.clone(),
            index: 6,
            delete_count: 0,
            insert: "X".into(),
        })
        .unwrap();
    assert_eq!(project.resolve_cursor(&id, &before).unwrap(), 6);
    assert_eq!(project.resolve_cursor(&id, &after).unwrap(), 7);
    let base = project.snapshot().unwrap();
    let mut remote = Project::from_snapshot(&base).unwrap();
    remote
        .apply(Command::EditText {
            id: id.clone(),
            index: 0,
            delete_count: 0,
            insert: "Remote ".into(),
        })
        .unwrap();
    project.merge(&remote.snapshot().unwrap()).unwrap();
    project
        .edit_draft(&id, &base, "Hello X🌲 draft", 15)
        .unwrap();
    assert_eq!(
        project.view().unwrap().nodes[0].text,
        "Remote Hello X🌲 draft"
    );
    let base = project.snapshot().unwrap();
    project
        .edit_draft(&id, &base, "Remote Hello X draft", 14)
        .unwrap();
    assert_eq!(
        project.view().unwrap().nodes[0].text,
        "Remote Hello X draft"
    );
}
