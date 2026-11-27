use crate::{
    AppState, Backend,
    auth::User,
    compute,
    error::{ApiError, Result},
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{
        Path, Query, RawQuery, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use mindgrab_state::{LinkStyle, PreferenceName};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(FromRow)]
struct Stored {
    snapshot: Option<Vec<u8>>,
    revision: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectId {
    project_id: Uuid,
}
/// What a merge or command left stored.
struct Merged {
    snapshot: Vec<u8>,
    revision: i64,
    /// None when the document's head is too long to name.
    head: Option<String>,
}
/// A read that says what its client holds, so the answer can leave that out.
/// A client that sends neither field holds nothing and gets the whole map.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Changes {
    project_id: Uuid,
    /// The cloud revision the client last saw.
    #[serde(default, deserialize_with = "text")]
    revision: Option<String>,
    /// A head the client's document holds; empty when it holds none.
    #[serde(default, deserialize_with = "text")]
    since: Option<String>,
}
/// A field that is a string whenever it is sent: null is refused like a number.
fn text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    project_id: Uuid,
    schema_version: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    limit: Option<i64>,
    cursor: Option<Uuid>,
    // One page of the most recently updated projects, for opening on a new device.
    recent: Option<bool>,
}
fn parse<T: serde::de::DeserializeOwned>(headers: &HeaderMap, body: &Bytes) -> Result<T> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        != Some("application/json")
    {
        return Err(ApiError::invalid());
    }
    serde_json::from_slice(body).map_err(|_| ApiError::invalid())
}
async fn stored(app: &Backend, user: &User, id: Uuid) -> Result<Stored> {
    sqlx::query_as("SELECT snapshot,revision FROM mindgrab_loro.projects WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(id).bind(user.id).fetch_optional(&app.pool).await?.ok_or_else(ApiError::missing)
}
/// The project's committed revision, without reading its snapshot: sockets
/// look it up on every change and every 20 seconds.
async fn revision(app: &Backend, user: &User, id: Uuid) -> Result<i64> {
    sqlx::query_scalar(
        "SELECT revision FROM mindgrab_loro.projects WHERE id=$1 AND owner_id=$2 AND NOT deleted",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&app.pool)
    .await?
    .ok_or_else(ApiError::missing)
}
/// What an account keeps in the cloud, against its [`crate::config::Quota`].
#[derive(FromRow)]
struct Usage {
    projects: i64,
    ids: i64,
    /// Bytes stored by its maps other than the one being saved.
    other_bytes: i64,
    /// Bytes the map being saved stores now.
    saving_bytes: i64,
}
/// Locks the account for the rest of `tx`, then measures what it stores
/// beside `saving`. Requests that check the quota before storing take turns,
/// so two of them cannot both fill the same room.
async fn usage(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: i64,
    saving: Option<Uuid>,
) -> Result<Usage> {
    sqlx::query("SELECT 1 FROM mindgrab_loro.users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(owner)
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query_as("SELECT count(*) FILTER (WHERE NOT deleted) AS projects,count(*) AS ids,COALESCE(sum(snapshot_bytes) FILTER (WHERE id IS DISTINCT FROM $2),0)::bigint AS other_bytes,COALESCE(sum(snapshot_bytes) FILTER (WHERE id=$2),0)::bigint AS saving_bytes FROM mindgrab_loro.projects WHERE owner_id=$1").bind(owner).bind(saving).fetch_one(&mut **tx).await?)
}
fn record(id: Uuid, name: Option<String>) -> Value {
    json!({"projectId":id,"schemaVersion":1,"format":"mindgrab-loro-v1","name":name})
}
fn baseline(id: Uuid, project: Stored) -> Value {
    json!({"projectId":id,"encoding":"loro-snapshot","data":STANDARD.encode(project.snapshot.unwrap_or_default()),"revision":project.revision.to_string(),"durable":true})
}
/// The answer to a client that names versions by head. `head` is the cloud
/// copy's. It is left out when no stored document was read to answer (the
/// revision asked about is still current, or nothing is stored yet) and when
/// the head cannot be named.
fn changes(id: Uuid, encoding: &str, data: &[u8], head: Option<String>, revision: i64) -> Value {
    let mut value = json!({"projectId":id,"encoding":encoding,"data":STANDARD.encode(data),"revision":revision.to_string(),"durable":true});
    if let Some(head) = head {
        value["head"] = json!(head);
    }
    value
}
/// A save's answer. The client holds what it sent, so a receipt naming the
/// stored head is enough; only a head too long to name needs the snapshot.
fn saved(id: Uuid, project: Merged) -> Response {
    let value = match project.head {
        Some(head) => changes(id, "loro-update", &[], Some(head), project.revision),
        None => baseline(
            id,
            Stored {
                snapshot: Some(project.snapshot),
                revision: project.revision,
            },
        ),
    };
    Json(value).into_response()
}

pub async fn callback(
    axum::extract::State(app): AppState,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    app.auth
        .callback(&headers, &query.unwrap_or_default())
        .await
}
async fn database_ready(app: &Backend) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&app.pool)
        )
        .await,
        Ok(Ok(1))
    )
}
/// Apache's default page, and Railway's healthcheck: a deployment goes live on this 200.
pub async fn index(axum::extract::State(app): AppState) -> Response {
    if database_ready(&app).await {
        (
            // PHP writes the charset in capitals.
            [(header::CONTENT_TYPE, "text/html; charset=UTF-8")],
            "<html><body><h1>It works!</h1></body></html>\n",
        )
            .into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
pub async fn health(axum::extract::State(app): AppState) -> Response {
    let started = std::time::Instant::now();
    let healthy = database_ready(&app).await;
    let ms = started.elapsed().as_secs_f64() * 1000.;
    let mut response = (if healthy {StatusCode::OK} else {StatusCode::SERVICE_UNAVAILABLE},Json(json!({"status":if healthy {"ok"} else {"degraded"},"database":{"status":if healthy {"up"} else {"down"},"latency_ms":if healthy {Some(ms)} else {None}}}))).into_response();
    response
        .headers_mut()
        .insert("server-timing", format!("db;dur={ms:.3}").parse().unwrap());
    response
}
/// The most a method reads of a request body, and how long the client has to
/// send it. A snapshot upload is the only large one; everything else is a few
/// identifiers.
fn body_limit(method: &str) -> (usize, Duration) {
    match method {
        // The slack lets the shared core, not this limit, refuse a snapshot that
        // is only just too large. A full snapshot takes a minute at 1.4 Mbit/s.
        "mergeProject" => (
            mindgrab_state::MAX_SNAPSHOT_BYTES + 4096,
            Duration::from_secs(60),
        ),
        // One command can carry a position for every idea on a full map.
        "commandProject" => (2 * 1024 * 1024, Duration::from_secs(30)),
        // A browser sends at most a hundred preferences at once, each at most
        // every color.
        "setPreferences" => (512 * 1024, Duration::from_secs(30)),
        _ => (16 * 1024, Duration::from_secs(10)),
    }
}
/// Refuses a body declared larger than the method's limit, before a byte of it
/// is read.
fn declared_within(method: &str, headers: &HeaderMap) -> Result<()> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared.is_some_and(|length| length > body_limit(method).0) {
        return Err(too_large());
    }
    Ok(())
}
fn too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large")
}
/// Reads a body up to the method's limit and within its time, so a client that
/// sends slowly cannot keep the buffer for long.
async fn read(method: &str, body: Body) -> Result<Bytes> {
    let (limit, time) = body_limit(method);
    tokio::time::timeout(time, axum::body::to_bytes(body, limit))
        .await
        .map_err(|_| ApiError::new(StatusCode::REQUEST_TIMEOUT, "request_timeout"))?
        .map_err(|_| too_large())
}
/// The body arrives unread. A method that needs a session checks it first, so a
/// request without one is refused before any of its body is held in memory.
pub async fn rpc(
    axum::extract::State(app): AppState,
    method: &'static str,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Body,
) -> Result<Response> {
    // Also for the methods that ignore their body: none of them takes a large one.
    declared_within(method, &headers)?;
    match method {
        "getHealth" => return Ok(health(axum::extract::State(app)).await),
        "startLogin" => return app.auth.start(&headers).await,
        "logout" => return app.auth.logout(&headers).await,
        "getMe" => return Ok(Json(app.auth.identify(&headers).await?).into_response()),
        // Anyone holding a share token may read; no session is involved.
        "getSharedProject" => {
            let body = read(method, body).await?;
            return shared(&app, &headers, &body).await;
        }
        "createProject" | "deleteProject" | "mergeProject" | "commandProject" | "setShareLink"
        | "setPreferences" => app.config.same_origin(&headers)?,
        "listProjects" | "getProjectSnapshot" | "getProjectState" | "getShareLink"
        | "listPreferences" => {}
        _ => unreachable!(),
    }
    let user = app.auth.identify(&headers).await?;
    let body = read(method, body).await?;
    match method {
        "createProject" => {
            let args: Create = parse(&headers, &body)?;
            if args.schema_version != 1 {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unsupported_schema",
                ));
            }
            let quota = app.config.quota;
            let mut tx = app.pool.begin().await?;
            let usage = usage(&mut tx, user.id, None).await?;
            let existing: Option<(i64, bool, Option<String>)> = sqlx::query_as(
                "SELECT owner_id,deleted,name FROM mindgrab_loro.projects WHERE id=$1 FOR UPDATE",
            )
            .bind(args.project_id)
            .fetch_optional(&mut *tx)
            .await?;
            let name = match existing {
                Some((owner, ..)) if owner != user.id => {
                    return Err(ApiError::new(StatusCode::CONFLICT, "project_id_conflict"));
                }
                Some((_, false, name)) => name,
                // Its ID is the account's already, so only the map counts.
                Some((_, true, name)) => {
                    if usage.projects >= quota.projects {
                        return Err(ApiError::quota_exceeded());
                    }
                    sqlx::query("UPDATE mindgrab_loro.projects SET deleted=false WHERE id=$1")
                        .bind(args.project_id)
                        .execute(&mut *tx)
                        .await?;
                    name
                }
                None => {
                    // The permanent cap first: deleting maps frees no ID.
                    if usage.ids >= quota.ids {
                        return Err(ApiError::id_quota_exceeded());
                    }
                    if usage.projects >= quota.projects {
                        return Err(ApiError::quota_exceeded());
                    }
                    // The account is locked, so a row that appeared meanwhile
                    // was added by another account.
                    let added = sqlx::query("INSERT INTO mindgrab_loro.projects(id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(args.project_id).bind(user.id).execute(&mut *tx).await?.rows_affected();
                    if added == 0 {
                        return Err(ApiError::new(StatusCode::CONFLICT, "project_id_conflict"));
                    }
                    None
                }
            };
            tx.commit().await?;
            Ok(Json(record(args.project_id, name)).into_response())
        }
        "deleteProject" => {
            let args: ProjectId = parse(&headers, &body)?;
            let mut tx = app.pool.begin().await?;
            // Deleting the cloud copy also revokes its share link.
            sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=NULL,name=NULL,share_token=NULL,shared_snapshot=NULL,shared_revision=NULL,deleted=true,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(args.project_id).bind(user.id).execute(&mut *tx).await?;
            notify(&mut tx, user.id, args.project_id).await?;
            tx.commit().await?;
            Ok(Json(json!({"deleted":true})).into_response())
        }
        "listProjects" => {
            let args: Page = parse(&headers, &body)?;
            let limit = args.limit.unwrap_or(100);
            let recent = args.recent.unwrap_or(false);
            // Recency order has no stable cursor, so it is a single page.
            if !(1..=100).contains(&limit) || (recent && args.cursor.is_some()) {
                return Err(ApiError::invalid());
            }
            let rows: Vec<(Uuid,Option<String>,String,i64)> = sqlx::query_as("SELECT id,name,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),revision FROM mindgrab_loro.projects WHERE owner_id=$1 AND NOT deleted AND snapshot IS NOT NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY CASE WHEN $4 THEN updated_at END DESC, id LIMIT $3").bind(user.id).bind(args.cursor).bind(limit+1).bind(recent).fetch_all(&app.pool).await?;
            let cursor = if rows.len() > limit as usize && !recent {
                rows.get(limit as usize - 1).map(|row| row.0)
            } else {
                None
            };
            Ok(Json(json!({"projects":rows.into_iter().take(limit as usize).map(|(id,name,updated_at,revision)|{let mut project=record(id,name);project["updatedAt"]=json!(updated_at);project["revision"]=json!(revision.to_string());project}).collect::<Vec<_>>(),"nextCursor":cursor})).into_response())
        }
        "getProjectSnapshot" => {
            let args: Changes = parse(&headers, &body)?;
            let id = args.project_id;
            // Most reads find nothing new: those are answered without reading
            // the snapshot or taking a turn.
            let (revision, initialized): (i64, bool) = sqlx::query_as("SELECT revision,snapshot IS NOT NULL FROM mindgrab_loro.projects WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(id).bind(user.id).fetch_optional(&app.pool).await?.ok_or_else(ApiError::missing)?;
            if args.revision == Some(revision.to_string()) {
                return Ok(Json(changes(id, "loro-update", &[], None, revision)).into_response());
            }
            if !initialized {
                return Ok(Json(changes(id, "loro-snapshot", &[], None, revision)).into_response());
            }
            // The turn comes first: waiting requests then hold no snapshot.
            let permit = app.compute.acquire(user.id).await?;
            let project = stored(&app, &user, id).await?;
            let revision = project.revision;
            // Deleted and created again while this waited.
            let Some(snapshot) = project.snapshot else {
                return Ok(Json(changes(id, "loro-snapshot", &[], None, revision)).into_response());
            };
            let since = args.since.unwrap_or_default();
            // The body is built off the executor too: it can be megabytes.
            let body = compute::run(&permit, move || {
                let sent = mindgrab_state::outgoing(&snapshot, &since)?;
                let value = match (sent.updates, sent.head) {
                    (Some(updates), Some(head)) => {
                        changes(id, "loro-update", &updates, Some(head), revision)
                    }
                    (_, head) => changes(id, "loro-snapshot", &snapshot, head, revision),
                };
                Ok(value.to_string().into_bytes())
            })
            .await?;
            Ok(([(header::CONTENT_TYPE, "application/json")], body).into_response())
        }
        "listPreferences" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Args {}
            let _: Args = parse(&headers, &body)?;
            Ok(Json(crate::preferences::list(&app.pool, &user).await?).into_response())
        }
        "setPreferences" => {
            let changes: crate::preferences::Changes = parse(&headers, &body)?;
            crate::preferences::change(&app.pool, &user, changes).await?;
            Ok(Json(json!({"saved":true})).into_response())
        }
        "getShareLink" => {
            let args: ProjectId = parse(&headers, &body)?;
            let token: Option<String> = sqlx::query_scalar("SELECT share_token FROM mindgrab_loro.projects WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(args.project_id).bind(user.id).fetch_optional(&app.pool).await?.ok_or_else(ApiError::missing)?;
            Ok(Json(json!({"projectId":args.project_id,"token":token})).into_response())
        }
        "setShareLink" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                project_id: Uuid,
                enabled: bool,
            }
            let args: Args = parse(&headers, &body)?;
            // One link per project: enabling keeps an existing token, and
            // disabling discards it, with what viewers load, so a later link
            // is a new one.
            let mut tx = app.pool.begin().await?;
            let token: Option<String> = sqlx::query_scalar("UPDATE mindgrab_loro.projects SET share_token=CASE WHEN $3 THEN COALESCE(share_token,$4) END,shared_snapshot=CASE WHEN $3 THEN shared_snapshot END,shared_revision=CASE WHEN $3 THEN shared_revision END WHERE id=$1 AND owner_id=$2 AND NOT deleted RETURNING share_token").bind(args.project_id).bind(user.id).bind(args.enabled).bind(crate::auth::token()).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
            // Wake open viewers so a revoked link closes promptly. This uses
            // its own channel: the content did not change, so the owner's
            // editors have nothing to sync.
            publish(&mut tx, format!("share/{}/{}", user.id, args.project_id)).await?;
            tx.commit().await?;
            Ok(Json(json!({"projectId":args.project_id,"token":token})).into_response())
        }
        "getProjectState" => {
            let args: ProjectId = parse(&headers, &body)?;
            // The turn comes first: waiting requests then hold no snapshot.
            let permit = app.compute.acquire(user.id).await?;
            let bytes = stored(&app, &user, args.project_id)
                .await?
                .snapshot
                .ok_or_else(ApiError::missing)?;
            let view = compute::run(&permit, move || {
                Ok(mindgrab_state::Project::from_snapshot(&bytes)?.view()?)
            })
            .await?;
            Ok(Json(view).into_response())
        }
        "mergeProject" => {
            if headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                != Some("application/octet-stream")
            {
                return Err(ApiError::invalid());
            }
            let pairs: Vec<_> =
                reqwest::Url::parse(&format!("http://localhost/?{}", query.unwrap_or_default()))
                    .map_err(|_| ApiError::invalid())?
                    .query_pairs()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
            if pairs.len() != 1 || pairs[0].0 != "projectId" {
                return Err(ApiError::invalid());
            }
            let id = Uuid::parse_str(&pairs[0].1).map_err(|_| ApiError::invalid())?;
            let project = merge(&app, &user, id, body, None).await?;
            Ok(saved(id, project))
        }
        "commandProject" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                project_id: Uuid,
                command: mindgrab_state::Command,
            }
            let args: Args = parse(&headers, &body)?;
            // Native commands operate on the same core used by browser editing.
            let project = merge(
                &app,
                &user,
                args.project_id,
                Bytes::new(),
                Some(args.command),
            )
            .await?;
            Ok(saved(args.project_id, project))
        }
        _ => unreachable!(),
    }
}
async fn notify(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: i64,
    id: Uuid,
) -> Result<()> {
    publish(tx, format!("{owner}/{id}")).await
}
async fn publish(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, payload: String) -> Result<()> {
    sqlx::query("SELECT pg_notify('mindgrab_loro',$1)")
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
/// Writers that find the project changed under them start over this many times.
const MERGE_ATTEMPTS: usize = 3;
/// Merges `bytes` and applies `command` to the stored project. Nothing is
/// locked and no connection is held while that computes: the result is stored
/// only if the project is still at the revision it was computed from. Merging
/// is idempotent, so starting over from a newer revision is safe.
async fn merge(
    app: &Backend,
    user: &User,
    id: Uuid,
    bytes: Bytes,
    command: Option<mindgrab_state::Command>,
) -> Result<Merged> {
    // A map kept out of the cloud is not stored there.
    if !crate::preferences::resolve(&app.pool, user.id, id, PreferenceName::SaveInCloud)
        .await?
        .unwrap_or(true)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_disabled",
        ));
    }
    let permit = app.compute.acquire(user.id).await?;
    for _ in 0..MERGE_ATTEMPTS {
        let current = stored(app, user, id).await?;
        let prior_bytes = current.snapshot.as_ref().map_or(0, Vec::len) as i64;
        let (prior, bytes, command) = (current.snapshot, bytes.clone(), command.clone());
        let (snapshot, name, changed, head) = compute::run(&permit, move || {
            let mut project = if let Some(ref prior) = prior {
                mindgrab_state::Project::from_snapshot(prior)?
            } else {
                mindgrab_state::Project::from_snapshot(&bytes)?
            };
            let before = project.version();
            if !bytes.is_empty() {
                project.merge(&bytes)?;
            }
            if let Some(command) = command {
                project.apply(command)?;
            }
            let view = project.view()?;
            let changed = prior.is_none() || before != project.version();
            let snapshot = match prior {
                Some(prior) if !changed => prior,
                _ => project.snapshot()?,
            };
            Ok((snapshot, view.name, changed, project.head()))
        })
        .await?;
        if !changed {
            return Ok(Merged {
                snapshot,
                revision: current.revision,
                head,
            });
        }
        let revision = current.revision + 1;
        let snapshot_bytes = snapshot.len() as i64;
        let mut tx = app.pool.begin().await?;
        // A map that grows must fit in the account's quota. One that does not
        // grow is always saved, so an account over its quota keeps what it has.
        if snapshot_bytes > prior_bytes {
            // Measured under the lock: should the map have changed since it
            // was read, a save that no longer grows it goes on to the update,
            // which stores nothing and starts over from the newer revision.
            let usage = usage(&mut tx, user.id, Some(id)).await?;
            if snapshot_bytes > usage.saving_bytes
                && usage.other_bytes + snapshot_bytes > app.config.quota.bytes
            {
                return Err(ApiError::quota_exceeded());
            }
        }
        let saved = sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=$3,name=$4,revision=$5,updated_at=now() WHERE id=$1 AND owner_id=$2 AND NOT deleted AND revision=$6").bind(id).bind(user.id).bind(&snapshot).bind(name).bind(revision).bind(current.revision).execute(&mut *tx).await?.rows_affected();
        if saved == 1 {
            notify(&mut tx, user.id, id).await?;
            tx.commit().await?;
            return Ok(Merged {
                snapshot,
                revision,
                head,
            });
        }
    }
    Err(ApiError::busy())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SocketQuery {
    owner_id: i64,
}
pub async fn socket(
    axum::extract::State(app): AppState,
    Path(id): Path<Uuid>,
    Query(args): Query<SocketQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    app.config.same_origin(&headers)?;
    let user = app.auth.identify(&headers).await?;
    if args.owner_id != user.id {
        return Err(ApiError::new(StatusCode::CONFLICT, "account_changed"));
    }
    revision(&app, &user, id).await?;
    // Subscribe before the upgrade so an edit during the handshake isn't lost.
    let receiver = app.changes.subscribe();
    let target = format!("{}/{id}", user.id);
    Ok(ws
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| {
            watch(socket, vec![target], receiver, async move || {
                if app.auth.identify(&headers).await.is_err() {
                    return Err("Sign in again");
                }
                revision(&app, &user, id)
                    .await
                    .map_err(|_| "Project unavailable")
            })
        }))
}

#[derive(FromRow)]
struct Shared {
    id: Uuid,
    owner_id: i64,
    name: Option<String>,
    revision: i64,
    /// What viewers load, when built for this revision and asked for.
    view: Option<Vec<u8>>,
}
async fn shared_project(app: &Backend, token: &str) -> Result<Shared> {
    shared_row(app, token, false).await
}
async fn shared_row(app: &Backend, token: &str, view: bool) -> Result<Shared> {
    // Tokens are 32 random bytes, URL-safe base64 without padding.
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::missing());
    }
    sqlx::query_as("SELECT id,owner_id,name,revision,CASE WHEN $2 AND shared_revision=revision THEN shared_snapshot END AS view FROM mindgrab_loro.projects WHERE share_token=$1 AND NOT deleted AND snapshot IS NOT NULL").bind(token).bind(view).fetch_optional(&app.pool).await?.ok_or_else(ApiError::missing)
}
/// The project as its viewers see it. The stored snapshot holds the full edit
/// history, deleted ideas and notes included, so viewers get a copy of only
/// the current map instead (`Project::share_snapshot`). It is built once per
/// revision and kept for the next viewer.
async fn shared_view(app: &Arc<Backend>, token: &str) -> Result<Shared> {
    for _ in 0..SHARE_ATTEMPTS {
        let project = shared_row(app, token, true).await?;
        if project.view.is_some() {
            return Ok(project);
        }
        let mut build = share_build(app, project.id, project.owner_id, project.revision);
        let built = build
            .wait_for(Option::is_some)
            .await
            .map_err(|_| ApiError::unavailable())?
            .clone();
        match built {
            Some(Built::Ready(view)) => {
                // The link may have been turned off during the build, or off
                // and on again, which gives it a new token.
                shared_project(app, token).await?;
                return Ok(Shared {
                    view: Some(view.to_vec()),
                    ..project
                });
            }
            // The owner saved meanwhile: build the newer revision instead.
            Some(Built::Stale) => continue,
            Some(Built::Failed(error)) => return Err(error),
            None => unreachable!(),
        }
    }
    Err(ApiError::busy())
}
/// Viewers that find the owner saved during a build start over this many times.
const SHARE_ATTEMPTS: usize = 3;
/// A finished build of viewers' copy of one project revision.
#[derive(Clone)]
pub(crate) enum Built {
    Ready(Arc<Vec<u8>>),
    /// The project has moved past that revision, or is no longer shared.
    Stale,
    Failed(ApiError),
}
/// Builds in progress, one per project revision, each awaited by every viewer
/// of that revision.
pub(crate) type ShareBuilds = Mutex<HashMap<(Uuid, i64), watch::Receiver<Option<Built>>>>;
/// Viewers of a revision share one build. It runs as its own task, so it takes
/// one of the owner's compute seats however many viewers wait, and a viewer
/// that gives up does not waste it.
fn share_build(
    app: &Arc<Backend>,
    id: Uuid,
    owner: i64,
    revision: i64,
) -> watch::Receiver<Option<Built>> {
    let mut builds = app.share_builds.lock().unwrap();
    // A build whose task has gone without an answer is started again.
    if let Some(build) = builds.get(&(id, revision))
        && build.has_changed().is_ok()
    {
        return build.clone();
    }
    let (sender, build) = watch::channel(None);
    builds.insert((id, revision), build.clone());
    let app = app.clone();
    tokio::spawn(async move {
        let built = match build_share(&app, id, owner, revision).await {
            Ok(Some(view)) => Built::Ready(Arc::new(view)),
            Ok(None) => Built::Stale,
            Err(error) => Built::Failed(error),
        };
        app.share_builds.lock().unwrap().remove(&(id, revision));
        let _ = sender.send(Some(built));
    });
    build
}
async fn build_share(
    app: &Backend,
    id: Uuid,
    owner: i64,
    revision: i64,
) -> Result<Option<Vec<u8>>> {
    // The turn comes first: waiting builds then hold no snapshot.
    let permit = app.compute.acquire(owner).await?;
    // Another server may have built it while this one waited.
    #[derive(FromRow)]
    struct Row {
        snapshot: Option<Vec<u8>>,
        view: Option<Vec<u8>>,
    }
    let row: Option<Row> = sqlx::query_as("SELECT snapshot,CASE WHEN shared_revision=revision THEN shared_snapshot END AS view FROM mindgrab_loro.projects WHERE id=$1 AND revision=$2 AND share_token IS NOT NULL AND NOT deleted").bind(id).bind(revision).fetch_optional(&app.pool).await?;
    let Some(Row {
        snapshot: Some(snapshot),
        view,
    }) = row
    else {
        return Ok(None);
    };
    if view.is_some() {
        return Ok(view);
    }
    let view = compute::run(&permit, move || {
        Ok(mindgrab_state::Project::from_snapshot(&snapshot)?.share_snapshot()?)
    })
    .await?;
    let saved = sqlx::query("UPDATE mindgrab_loro.projects SET shared_snapshot=$3,shared_revision=$2 WHERE id=$1 AND revision=$2 AND share_token IS NOT NULL AND NOT deleted").bind(id).bind(revision).bind(&view).execute(&app.pool).await?.rows_affected();
    // Saving nothing means the owner saved, unshared or deleted meanwhile:
    // no viewer gets this copy, and each looks again.
    Ok((saved == 1).then_some(view))
}
async fn shared(app: &Arc<Backend>, headers: &HeaderMap, body: &Bytes) -> Result<Response> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Args {
        token: String,
    }
    let args: Args = parse(headers, body)?;
    let project = shared_view(app, &args.token).await?;
    let (own, global): (Option<LinkStyle>, Option<LinkStyle>) = crate::preferences::levels(
        &app.pool,
        project.owner_id,
        project.id,
        PreferenceName::LinkStyle,
    )
    .await?;
    // An older map keeps its own style in its document until its owner opens
    // it and it moves into preferences; the share snapshot carries it so far.
    // Reading it decodes the snapshot, so it takes one of the owner's compute
    // seats, and only when the map has no style of its own.
    let own = match (own, project.view.clone()) {
        (Some(own), _) => Some(own),
        (None, Some(view)) => {
            let permit = app.compute.acquire(project.owner_id).await?;
            compute::run(&permit, move || {
                Ok(mindgrab_state::Project::from_snapshot(&view)?
                    .view()?
                    .legacy
                    .and_then(|legacy| legacy.links))
            })
            .await?
        }
        (None, None) => None,
    };
    let style = own.or(global).unwrap_or_default();
    let mut value = baseline(
        project.id,
        Stored {
            snapshot: project.view,
            revision: project.revision,
        },
    );
    value["name"] = json!(project.name);
    value["linkStyle"] = json!(style);
    Ok(Json(value).into_response())
}
/// Read-only revision notifications for a shared project. The link itself is
/// the credential, so the socket closes as soon as it is revoked.
pub async fn shared_socket(
    axum::extract::State(app): AppState,
    Path(token): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    app.config.same_origin(&headers)?;
    let project = shared_project(&app, &token).await?;
    let receiver = app.changes.subscribe();
    let target = format!("{}/{}", project.owner_id, project.id);
    // Content changes and share link changes both concern viewers.
    let targets = vec![format!("share/{target}"), target];
    Ok(ws
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| {
            watch(
                socket,
                targets,
                receiver,
                async move || match shared_project(&app, &token).await {
                    Ok(project) => Ok(project.revision),
                    Err(_) => Err("Link disabled"),
                },
            )
        }))
}
/// Sends the committed revision whenever one of `targets` is notified (and
/// periodically), closing with `check`'s reason once access ends.
async fn watch(
    mut socket: WebSocket,
    targets: Vec<String>,
    mut receiver: tokio::sync::broadcast::Receiver<String>,
    mut check: impl AsyncFnMut() -> std::result::Result<i64, &'static str>,
) {
    let mut timer = tokio::time::interval(Duration::from_secs(20));
    loop {
        let changed = tokio::select! {
            received = receiver.recv() => match received { Ok(value) => targets.contains(&value), Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true, Err(_) => break },
            _ = timer.tick() => true,
            message = socket.recv() => match message { Some(Ok(Message::Ping(bytes))) => {if socket.send(Message::Pong(bytes)).await.is_err(){break;} false}, Some(Ok(Message::Pong(_))) => false, _ => break },
        };
        if !changed {
            continue;
        }
        let revision = match check().await {
            Ok(revision) => revision,
            Err(reason) => {
                let _ = socket
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 1008,
                        reason: reason.into(),
                    })))
                    .await;
                break;
            }
        };
        if socket
            .send(Message::Text(
                json!({"revision":revision.to_string()}).to_string().into(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }
}
