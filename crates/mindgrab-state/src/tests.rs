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
fn concurrent_existing_note_edits_and_drafts_merge() {
    let mut seed = Project::new("Note drafts").unwrap();
    let id = create(&mut seed, None, "idea");
    seed.apply(Command::SetNote {
        id: id.clone(),
        note: "Hello 🌲".into(),
    })
    .unwrap();
    let base = seed.snapshot().unwrap();
    let mut left = Project::from_snapshot(&base).unwrap();
    let mut right = Project::from_snapshot(&base).unwrap();
    let before = left.note_cursor(&id, 6, false).unwrap();
    let after = left.note_cursor(&id, 6, true).unwrap();
    right
        .apply(Command::EditNote {
            id: id.clone(),
            index: 6,
            delete_count: 0,
            insert: "X".into(),
        })
        .unwrap();
    left.merge(&right.snapshot().unwrap()).unwrap();
    assert_eq!(left.resolve_note_cursor(&id, &before).unwrap(), 6);
    assert_eq!(left.resolve_note_cursor(&id, &after).unwrap(), 7);
    let caret = left
        .edit_note_draft(&id, &base, "Local Hello 🌲", 6)
        .unwrap();
    assert_eq!(caret, 6);
    right.merge(&left.snapshot().unwrap()).unwrap();
    assert_eq!(note(&left, &id), "Local Hello X🌲");
    assert_eq!(left.view().unwrap(), right.view().unwrap());
    left.apply(Command::Undo).unwrap();
    assert_eq!(note(&left, &id), "Hello X🌲");
    left.apply(Command::Redo).unwrap();
    assert_eq!(note(&left, &id), "Local Hello X🌲");
    assert!(left.resolve_cursor(&id, &before).is_err());
    assert!(
        left.resolve_note_cursor(&id, &left.cursor(&id, 0, false).unwrap())
            .is_err()
    );
    assert!(left.note_cursor(&id, 14, false).is_err());
}

#[test]
fn first_note_draft_rebases_over_remote_first_edit() {
    let mut seed = Project::new("Empty draft").unwrap();
    let id = create(&mut seed, None, "idea");
    let base = seed.snapshot().unwrap();
    let mut remote = Project::from_snapshot(&base).unwrap();
    remote
        .apply(Command::SetNote {
            id: id.clone(),
            note: "remote".into(),
        })
        .unwrap();
    seed.merge(&remote.snapshot().unwrap()).unwrap();
    seed.edit_note_draft(&id, &base, "local", 5).unwrap();
    let merged = note(&seed, &id);
    assert!(merged == "localremote" || merged == "remotelocal");
}

#[test]
fn note_edits_undo_redo_and_delete_restore_content() {
    let mut project = Project::new("Undo notes").unwrap();
    let id = create(&mut project, None, "idea");
    project.clear_history();
    for value in ["first", "second", ""] {
        project.start_group().unwrap();
        project
            .apply(Command::SetNote {
                id: id.clone(),
                note: value.into(),
            })
            .unwrap();
        project.stop_group();
    }
    for expected in ["second", "first", ""] {
        project.apply(Command::Undo).unwrap();
        assert_eq!(note(&project, &id), expected);
    }
    for expected in ["first", "second", ""] {
        project.apply(Command::Redo).unwrap();
        assert_eq!(note(&project, &id), expected);
    }
    project
        .apply(Command::SetNote {
            id: id.clone(),
            note: "restored".into(),
        })
        .unwrap();
    project.clear_history();
    project
        .apply(Command::DeleteNode { id: id.clone() })
        .unwrap();
    project.apply(Command::Undo).unwrap();
    assert_eq!(note(&project, &id), "restored");
}

#[test]
fn invalid_notes_do_not_activate_containers_or_change_history() {
    let mut project = Project::new("Note limits").unwrap();
    let id = create(&mut project, None, "idea");
    project.clear_history();
    let version = project.version();
    for command in [
        Command::SetNote {
            id: id.clone(),
            note: "😀".repeat(MAX_TEXT_UTF16 / 2 + 1),
        },
        Command::EditNote {
            id: id.clone(),
            index: 0,
            delete_count: 0,
            insert: "x".repeat(MAX_TEXT_UTF16 + 1),
        },
        Command::EditNote {
            id: id.clone(),
            index: 1,
            delete_count: 0,
            insert: "x".into(),
        },
        Command::EditNote {
            id: id.clone(),
            index: 0,
            delete_count: usize::MAX,
            insert: "".into(),
        },
        Command::SetNote {
            id: "missing".into(),
            note: "x".into(),
        },
    ] {
        assert!(project.apply(command).is_err());
        assert_eq!(project.version(), version);
        assert!(!project.can_undo());
        assert_eq!(note(&project, &id), "");
    }
    project
        .apply(Command::SetNote {
            id: id.clone(),
            note: "😀".repeat(MAX_TEXT_UTF16 / 2),
        })
        .unwrap();
    let version = project.version();
    for (index, delete_count, insert) in [(1, 0, ""), (0, 1, ""), (0, 0, "x"), (usize::MAX, 1, "")]
    {
        assert!(
            project
                .apply(Command::EditNote {
                    id: id.clone(),
                    index,
                    delete_count,
                    insert: insert.into()
                })
                .is_err()
        );
        assert_eq!(project.version(), version);
    }
    project
        .apply(Command::EditNote {
            id: id.clone(),
            index: 0,
            delete_count: 2,
            insert: "🦀".into(),
        })
        .unwrap();
    assert!(note(&project, &id).starts_with("🦀"));
}

#[test]
fn invalid_stored_notes_including_hidden_nodes_are_rejected_atomically() {
    let mut project = Project::new("Remote validation").unwrap();
    let id = create(&mut project, None, "idea");
    let snapshot = project.snapshot().unwrap();
    for oversized in [false, true] {
        let raw = LoroDoc::from_snapshot(&snapshot).unwrap();
        let tree = raw.get_tree("nodes");
        let node = TreeID::try_from(id.as_str()).unwrap();
        let meta = tree.get_meta(node).unwrap();
        if oversized {
            meta.ensure_mergeable_text("note")
                .unwrap()
                .insert(0, &"x".repeat(MAX_TEXT_UTF16 + 1))
                .unwrap();
        } else {
            meta.insert("note", "plain string is invalid").unwrap();
        }
        tree.delete(node).unwrap();
        raw.commit();
        let bytes = raw.export(ExportMode::Snapshot).unwrap();
        assert!(Project::from_snapshot(&bytes).is_err());
        assert!(project.merge(&bytes).is_err());
        assert_eq!(note(&project, &id), "");
    }
}

#[test]
fn a_new_node_and_its_first_note_undo_as_one_step() {
    // Pasting a branch creates nodes and sets their notes in one undo group.
    let mut project = Project::new("Paste").unwrap();
    let root = create(&mut project, None, "root");
    project.clear_history();
    let before = serde_json::to_value(project.view().unwrap()).unwrap();
    project.start_group().unwrap();
    let child = create(&mut project, Some(&root), "pasted");
    project
        .apply(Command::SetNote {
            id: child,
            note: "carried note".into(),
        })
        .unwrap();
    create(&mut project, Some(&root), "second");
    project.stop_group();
    project.apply(Command::Undo).unwrap();
    assert_eq!(
        serde_json::to_value(project.view().unwrap()).unwrap(),
        before
    );
    assert!(!project.can_undo());
}

#[test]
fn a_first_note_on_a_legacy_node_undoes_as_its_own_step() {
    // Nodes created before notes existed activate their note lazily, in a
    // commit excluded from undo. The editor gives note editing its own undo
    // step, so the activation never sits inside a step with other edits.
    let mut project = Project::new("Legacy").unwrap();
    let legacy = create(&mut project, None, "legacy");
    project
        .tree()
        .get_meta(project.node(&legacy).unwrap())
        .unwrap()
        .delete("note")
        .unwrap();
    project.doc.commit();
    project.clear_history();
    let before = serde_json::to_value(project.view().unwrap()).unwrap();
    project.start_group().unwrap();
    project
        .apply(Command::SetNote {
            id: legacy.clone(),
            note: "first".into(),
        })
        .unwrap();
    project.stop_group();
    project.apply(Command::Undo).unwrap();
    assert_eq!(
        serde_json::to_value(project.view().unwrap()).unwrap(),
        before
    );
}

#[test]
fn undoing_a_step_that_created_and_deleted_a_node_keeps_the_view_valid() {
    let mut project = Project::new("Undo").unwrap();
    let root = create(&mut project, None, "root");
    project.clear_history();
    let before = serde_json::to_value(project.view().unwrap()).unwrap();
    project.start_group().unwrap();
    let parent = create(&mut project, Some(&root), "temporary");
    create(&mut project, Some(&parent), "child");
    project.apply(Command::DeleteNode { id: parent }).unwrap();
    project.stop_group();
    project.apply(Command::Undo).unwrap();
    assert_eq!(
        serde_json::to_value(project.view().unwrap()).unwrap(),
        before
    );
    project.apply(Command::Redo).unwrap();
    assert_eq!(
        serde_json::to_value(project.view().unwrap()).unwrap(),
        before
    );
    let restored = Project::from_snapshot(&project.snapshot().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(restored.view().unwrap()).unwrap(),
        before
    );
}

#[test]
fn deleted_nodes_do_not_count_toward_the_node_limit() {
    // Loro keeps deleted nodes as tombstones; a long-lived map that has
    // created and deleted more than MAX_NODES ideas must stay usable.
    let mut project = Project::new("Churn").unwrap();
    let root = create(&mut project, None, "root");
    for _ in 0..(MAX_NODES / 1000 + 1) {
        let ids: Vec<String> = (0..1000)
            .map(|_| create(&mut project, Some(&root), "x"))
            .collect();
        for id in ids {
            project.apply(Command::DeleteNode { id }).unwrap();
        }
    }
    assert_eq!(project.view().unwrap().nodes.len(), 1);
    create(&mut project, Some(&root), "still possible");
    assert_eq!(project.view().unwrap().nodes.len(), 2);
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
        r1.apply(Command::DeleteNode { id: deleted }).unwrap();
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
