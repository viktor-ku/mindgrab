use std::{collections::BTreeMap, fs, path::PathBuf};

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::*;
use crate::{
    auth::tests::{fixture, session_for, sign_in},
    project::updates::tests::{INITIAL, binary, get, javascript, new_id, put, register},
};

fn flattened(forest: &Value) -> Value {
    let mut result = serde_json::Map::new();
    let mut stack = vec![(Value::Null, forest.as_array().unwrap())];
    while let Some((parent, children)) = stack.pop() {
        for (order, node) in children.iter().enumerate() {
            result.insert(
                node["id"].as_str().unwrap().into(),
                json!({"parent": parent, "siblingOrder": order}),
            );
            stack.push((node["id"].clone(), node["children"].as_array().unwrap()));
        }
    }
    Value::Object(result)
}

// JSON has one number type; serde_json distinguishes integer/floating tokens.
// Compare positions through the shared DTO so -8 and -8.0 mean the same value.
fn canonical(value: &Value) -> Value {
    serde_json::to_value(serde_json::from_value::<Content>(value.clone()).unwrap()).unwrap()
}

async fn owner(pool: &PgPool, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn shared_goldens_match_js_content_and_effective_trees_after_duplicate_reversed_delivery(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/yjs-contract/fixtures");
    for entry in fs::read_dir(&fixtures).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let expected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let updates: Vec<_> = expected["updates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| fs::read(fixtures.join(name.as_str().unwrap())).unwrap())
            .collect();
        for reverse in [false, true] {
            let id = register(&f.state, &cookie).await;
            let ordered: Vec<_> = if reverse {
                updates.iter().rev().collect()
            } else {
                updates.iter().collect()
            };
            for bytes in ordered {
                let update = new_id();
                let receipt = put(&f.state, &cookie, id, update, bytes).await;
                assert_eq!(receipt.0, StatusCode::CREATED, "{}", path.display());
                assert_eq!(put(&f.state, &cookie, id, update, bytes).await.1, receipt.1);
                assert_eq!(get(&f.state, &cookie, id, "state").await.0, StatusCode::OK);
            }
            let state = get(&f.state, &cookie, id, "state").await.1;
            assert_eq!(state["current"], true, "{}", path.display());
            assert_eq!(
                state["content"],
                canonical(&expected["expected"]),
                "{}",
                path.display()
            );
            assert_eq!(state["placements"], flattened(&expected["forest"]));
            assert_eq!(
                state["freshness"]["nodeCount"],
                state["placements"].as_object().unwrap().len()
            );
            assert_eq!(
                state["freshness"]["sourceSequence"],
                updates.len().to_string()
            );
            let js = javascript(json!({"verify": true, "updates": updates}));
            assert_eq!(state["content"], canonical(&js["content"]));
            assert_eq!(state["placements"], flattened(&js["forest"]));
        }
    }
}

#[sqlx::test]
async fn uninitialized_and_owner_boundaries_never_expose_or_seed_content(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let other = session_for(&f, "other_user").await;
    let id = register(&f.state, &cookie).await;
    let initial = get(&f.state, &cookie, id, "state").await;
    assert_eq!(initial.0, StatusCode::OK);
    assert_eq!(initial.1["content"], Value::Null);
    assert_eq!(initial.1["current"], false);
    assert_eq!(initial.1["freshness"]["status"], "uninitialized");
    assert_eq!(initial.1["freshness"]["sourceSequence"], Value::Null);
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    for (session, status) in [
        ("", StatusCode::UNAUTHORIZED),
        (other.as_str(), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(get(&f.state, session, id, "state").await.0, status);
    }
    assert_eq!(
        get(&f.state, &other, new_id(), "state").await.1,
        get(&f.state, &other, id, "state").await.1
    );
    assert!(matches!(
        current_state(&f.state.pool, owner(&f.state.pool, id).await + 10, id).await,
        Err(ApiError::NotFound)
    ));
}

#[sqlx::test]
async fn causal_gaps_keep_the_last_complete_projection_then_catch_up_including_deletions(
    pool: PgPool,
) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), &binary(&data["gapBase"])).await;
    let first = get(&f.state, &cookie, id, "state").await.1;
    put(&f.state, &cookie, id, new_id(), &binary(&data["gapped"])).await;
    catch_up(&f.state.pool).await.unwrap();
    let pending = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(pending["current"], false);
    assert_eq!(pending["freshness"]["status"], "pending_dependencies");
    assert_eq!(pending["freshness"]["lastSequence"], "2");
    assert_eq!(pending["freshness"]["attemptedSequence"], "2");
    assert_eq!(pending["freshness"]["sourceSequence"], "1");
    assert_eq!(pending["content"], first["content"]);
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["predecessor"]),
    )
    .await;
    catch_up(&f.state.pool).await.unwrap();
    let ready = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(ready["current"], true);
    assert_eq!(ready["content"], canonical(&data["gapExpected"]));
    assert_eq!(ready["freshness"]["sourceSequence"], "3");
    put(&f.state, &cookie, id, new_id(), &binary(&data["deletion"])).await;
    let deleted = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(deleted["content"], canonical(&data["deleteExpected"]));
    assert_eq!(deleted["freshness"]["sourceSequence"], "4");
    // No valid prefix exists when the first submitted update is gapped.
    let empty = register(&f.state, &cookie).await;
    put(&f.state, &cookie, empty, new_id(), &binary(&data["gapped"])).await;
    let missing = get(&f.state, &cookie, empty, "state").await.1;
    assert_eq!(missing["content"], Value::Null);
    assert_eq!(missing["placements"], json!({}));
    assert_eq!(missing["freshness"]["status"], "pending_dependencies");
}

#[sqlx::test]
async fn rebuild_repairs_deleted_corrupt_rows_and_summaries_from_checkpoint_and_tail(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["deleteBase"]),
    )
    .await;
    put(&f.state, &cookie, id, new_id(), &binary(&data["deletion"])).await;
    let expected = get(&f.state, &cookie, id, "state").await.1;
    // Model a published checkpoint with a delete-only tail. No production
    // compaction/pruning is introduced by this read-model task.
    let checkpoint = binary(&data["deleteBase"]);
    sqlx::query("INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES ($1, 1, $2, $3)")
        .bind(id).bind(&checkpoint).bind(updates::digest(&checkpoint)).execute(&f.state.pool).await.unwrap();
    sqlx::query("DELETE FROM crdt_update WHERE project_id = $1 AND sequence = 1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crdt_node_read SET text = convert_to('corrupt', 'UTF8'), effective_parent = NULL, sibling_order = 99 WHERE project_id = $1 AND NOT deleted").bind(id).execute(&f.state.pool).await.unwrap();
    sqlx::query("UPDATE crdt_project SET name = 'corrupt', name_utf8 = convert_to('corrupt', 'UTF8'), node_count = 999 WHERE id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    rebuild_all(&f.state.pool).await.unwrap();
    assert_eq!(get(&f.state, &cookie, id, "state").await.1, expected);
    sqlx::query("DELETE FROM crdt_node_read WHERE project_id = $1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    rebuild_all(&f.state.pool).await.unwrap();
    rebuild_all(&f.state.pool).await.unwrap();
    assert_eq!(get(&f.state, &cookie, id, "state").await.1, expected);
    let rows: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT source_sequence FROM crdt_node_read WHERE project_id = $1",
    )
    .bind(id)
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(rows, vec![2]);
}

#[sqlx::test]
async fn failed_projection_commit_preserves_updates_and_the_old_atomic_view(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["deleteBase"]),
    )
    .await;
    let first = get(&f.state, &cookie, id, "state").await.1;
    sqlx::raw_sql("CREATE FUNCTION fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_projection AFTER INSERT ON crdt_node_read DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_projection();")
        .execute(&f.state.pool).await.unwrap();
    let receipt = put(&f.state, &cookie, id, new_id(), &binary(&data["deletion"])).await;
    assert_eq!(receipt.0, StatusCode::CREATED);
    assert_eq!(receipt.1["durable"], true);
    assert_eq!(
        get(&f.state, &cookie, id, "state").await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let (sequence, name): (Option<i64>, String) =
        sqlx::query_as("SELECT projection_sequence, name FROM crdt_project WHERE id = $1")
            .bind(id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(sequence, Some(1));
    assert_eq!(name, first["content"]["metadata"]["name"]);
    let text: Utf8Text = sqlx::query_scalar("SELECT text FROM crdt_node_read WHERE project_id = $1 AND node_id = '20000000-0000-4000-8000-000000000001'").bind(id).fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(
        text.0,
        first["content"]["nodes"]["20000000-0000-4000-8000-000000000001"]["text"]
    );
    sqlx::raw_sql(
        "DROP TRIGGER fail_projection ON crdt_node_read; DROP FUNCTION fail_projection();",
    )
    .execute(&f.state.pool)
    .await
    .unwrap();
    catch_up(&f.state.pool).await.unwrap();
    assert_eq!(
        get(&f.state, &cookie, id, "state").await.1["content"],
        canonical(&data["deleteExpected"])
    );
    assert_eq!(
        get(&f.state, &cookie, id, "updates").await.1["updates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[sqlx::test]
async fn competing_jobs_and_appends_never_regress_source_sequence(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(&f.state, &cookie, id, new_id(), INITIAL).await;
    let owner = owner(&f.state.pool, id).await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let state = f.state.clone();
        let cookie = cookie.clone();
        tasks.spawn(async move {
            assert_eq!(
                put(&state, &cookie, id, new_id(), INITIAL).await.0,
                StatusCode::CREATED
            );
            rebuild_project(&state.pool, owner, id).await.unwrap();
        });
    }
    let mut previous = 0;
    while !tasks.is_empty() {
        let observed = current_state(&f.state.pool, owner, id).await.unwrap();
        assert!(observed.current);
        let sequence = observed.freshness.source_sequence.unwrap();
        assert!(sequence >= previous);
        previous = sequence;
        tasks.join_next().await.unwrap().unwrap();
    }
    catch_up(&f.state.pool).await.unwrap();
    let final_state = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(final_state["freshness"]["sourceSequence"], "13");
    // A job scheduled before a newer publication still reloads under the lock.
    rebuild_project(&f.state.pool, owner, id).await.unwrap();
    assert_eq!(get(&f.state, &cookie, id, "state").await.1, final_state);
}

#[sqlx::test]
async fn quarantined_content_is_marked_and_rebuild_clears_untrusted_caches_only(pool: PgPool) {
    let data = javascript(json!({}));
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let id = register(&f.state, &cookie).await;
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["invalidBase"]),
    )
    .await;
    let first = get(&f.state, &cookie, id, "state").await.1;
    put(
        &f.state,
        &cookie,
        id,
        new_id(),
        &binary(&data["invalidPending"]),
    )
    .await;
    put(&f.state, &cookie, id, new_id(), &binary(&data["withheld"])).await;
    let invalid = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(invalid["freshness"]["status"], "quarantined");
    assert_eq!(invalid["current"], false);
    assert_eq!(invalid["content"], first["content"]);
    rebuild_all(&f.state.pool).await.unwrap();
    let rebuilt = get(&f.state, &cookie, id, "state").await.1;
    assert_eq!(rebuilt["freshness"]["status"], "quarantined");
    assert_eq!(rebuilt["content"], Value::Null);
    assert_eq!(
        get(&f.state, &cookie, id, "updates").await.1["updates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn flat_projection_handles_the_contract_limit_without_recursive_layout() {
    let mut nodes = BTreeMap::new();
    let mut parent = None;
    for number in 0..10_000 {
        let id = format!("20000000-0000-4000-8000-{number:012}");
        nodes.insert(
            id.clone(),
            Node {
                text: String::new(),
                color: "blue".into(),
                deleted: false,
                placement: Placement {
                    parent: parent.clone(),
                    rank: "a0".into(),
                },
                position: None,
            },
        );
        parent = Some(id);
    }
    let content = Content {
        schema_version: 1,
        metadata: Metadata {
            name: "Deep".into(),
        },
        nodes,
    };
    let placements = projection::project(&content);
    assert_eq!(placements.len(), 10_000);
    assert_eq!(
        placements.values().filter(|p| p.parent.is_none()).count(),
        1
    );
}

#[sqlx::test]
async fn empty_forests_and_nul_unicode_round_trip_through_read_models_and_catalog(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    for input in [json!({"nul": true}), json!({"empty": true})] {
        let data = javascript(input);
        let id = register(&f.state, &cookie).await;
        assert_eq!(
            put(&f.state, &cookie, id, new_id(), &binary(&data["initial"]))
                .await
                .0,
            StatusCode::CREATED
        );
        catch_up(&f.state.pool).await.unwrap();
        let state = get(&f.state, &cookie, id, "state").await.1;
        assert_eq!(state["content"], canonical(&data["content"]));
        assert_eq!(state["placements"], flattened(&data["forest"]));
        let catalog =
            super::super::owned_project(&f.state.pool, id, owner(&f.state.pool, id).await)
                .await
                .unwrap()
                .unwrap();
        let catalog = serde_json::to_value(catalog).unwrap();
        assert_eq!(catalog["name"], data["content"]["metadata"]["name"]);
        assert_eq!(
            catalog["nodeCount"],
            state["placements"].as_object().unwrap().len()
        );
        assert_eq!(catalog["projectionSequence"], "1");
        assert_eq!(catalog["projectionStatus"], "ready");
        assert_eq!(catalog["projectionVersion"], VERSION);
        rebuild_all(&f.state.pool).await.unwrap();
        assert_eq!(get(&f.state, &cookie, id, "state").await.1, state);
    }
}

#[sqlx::test]
async fn failed_projects_cannot_starve_later_pages_of_the_worker(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let mut ids = Vec::new();
    for _ in 0..51 {
        let id = register(&f.state, &cookie).await;
        assert_eq!(
            put(&f.state, &cookie, id, new_id(), INITIAL).await.0,
            StatusCode::CREATED
        );
        ids.push(id);
    }
    ids.sort();
    // Fail the first page at COMMIT, after each model was staged. Healthy
    // projects in later pages still publish during the next worker poll.
    sqlx::raw_sql("CREATE FUNCTION fail_first_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id < (SELECT MAX(id::TEXT)::UUID FROM crdt_project) THEN RAISE EXCEPTION 'injected page failure'; END IF; RETURN NEW; END; $$; CREATE CONSTRAINT TRIGGER fail_first_page AFTER INSERT ON crdt_node_read DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_first_page();")
        .execute(&f.state.pool).await.unwrap();
    let next = catch_up_page(&f.state.pool, None).await.unwrap();
    assert_eq!(next, Some(ids[49]));
    let last = catch_up_page(&f.state.pool, next).await.unwrap();
    assert_eq!(last, Some(ids[50]));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM crdt_project WHERE projection_sequence = 1")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    assert_eq!(catch_up_page(&f.state.pool, last).await.unwrap(), None);
    sqlx::raw_sql(
        "DROP TRIGGER fail_first_page ON crdt_node_read; DROP FUNCTION fail_first_page();",
    )
    .execute(&f.state.pool)
    .await
    .unwrap();
    let next = catch_up_page(&f.state.pool, None).await.unwrap();
    assert_eq!(next, Some(ids[49]));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM crdt_project WHERE projection_sequence = 1")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 51);
}
