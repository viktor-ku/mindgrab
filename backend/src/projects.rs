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
fn record(id: Uuid, name: Option<String>) -> Value {
    json!({"projectId":id,"schemaVersion":1,"format":"mindgrab-loro-v1","name":name})
}
fn baseline(id: Uuid, project: Stored) -> Value {
    json!({"projectId":id,"encoding":"loro-snapshot","data":STANDARD.encode(project.snapshot.unwrap_or_default()),"revision":project.revision.to_string(),"durable":true})
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
/// The most a method reads of a request body. A snapshot upload is the only large
/// one; everything else is a few identifiers.
fn body_limit(method: &str) -> usize {
    match method {
        // The slack lets the shared core, not this limit, refuse a snapshot that
        // is only just too large.
        "mergeProject" => mindgrab_state::MAX_SNAPSHOT_BYTES + 4096,
        // One command can carry a position for every idea on a full map.
        "commandProject" => 2 * 1024 * 1024,
        _ => 16 * 1024,
    }
}
/// Reads a body up to the method's limit. A declared length over the limit is
/// refused before a byte is read.
async fn read(method: &str, headers: &HeaderMap, body: Body) -> Result<Bytes> {
    let limit = body_limit(method);
    let too_large = || ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared.is_some_and(|length| length > limit) {
        return Err(too_large());
    }
    axum::body::to_bytes(body, limit)
        .await
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
    match method {
        "getHealth" => return Ok(health(axum::extract::State(app)).await),
        "startLogin" => return app.auth.start(&headers).await,
        "logout" => return app.auth.logout(&headers).await,
        "getMe" => return Ok(Json(app.auth.identify(&headers).await?).into_response()),
        // Anyone holding a share token may read; no session is involved.
        "getSharedProject" => {
            let body = read(method, &headers, body).await?;
            return shared(&app, &headers, &body).await;
        }
        "createProject" | "deleteProject" | "mergeProject" | "commandProject" | "setShareLink" => {
            app.config.same_origin(&headers)?
        }
        "listProjects" | "getProjectSnapshot" | "getProjectState" | "getShareLink" => {}
        _ => unreachable!(),
    }
    let user = app.auth.identify(&headers).await?;
    let body = read(method, &headers, body).await?;
    match method {
        "createProject" => {
            let args: Create = parse(&headers, &body)?;
            if args.schema_version != 1 {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unsupported_schema",
                ));
            }
            let mut tx = app.pool.begin().await?;
            sqlx::query("INSERT INTO mindgrab_loro.projects(id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(args.project_id).bind(user.id).execute(&mut *tx).await?;
            let owner: i64 = sqlx::query_scalar(
                "SELECT owner_id FROM mindgrab_loro.projects WHERE id=$1 FOR UPDATE",
            )
            .bind(args.project_id)
            .fetch_one(&mut *tx)
            .await?;
            if owner != user.id {
                return Err(ApiError::new(StatusCode::CONFLICT, "project_id_conflict"));
            }
            sqlx::query("UPDATE mindgrab_loro.projects SET deleted=false WHERE id=$1")
                .bind(args.project_id)
                .execute(&mut *tx)
                .await?;
            let name: Option<String> =
                sqlx::query_scalar("SELECT name FROM mindgrab_loro.projects WHERE id=$1")
                    .bind(args.project_id)
                    .fetch_one(&mut *tx)
                    .await?;
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
            let rows: Vec<(Uuid,Option<String>,String)> = sqlx::query_as("SELECT id,name,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM mindgrab_loro.projects WHERE owner_id=$1 AND NOT deleted AND snapshot IS NOT NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY CASE WHEN $4 THEN updated_at END DESC, id LIMIT $3").bind(user.id).bind(args.cursor).bind(limit+1).bind(recent).fetch_all(&app.pool).await?;
            let cursor = if rows.len() > limit as usize && !recent {
                rows.get(limit as usize - 1).map(|row| row.0)
            } else {
                None
            };
            Ok(Json(json!({"projects":rows.into_iter().take(limit as usize).map(|(id,name,updated_at)|{let mut project=record(id,name);project["updatedAt"]=json!(updated_at);project}).collect::<Vec<_>>(),"nextCursor":cursor})).into_response())
        }
        "getProjectSnapshot" => {
            let args: ProjectId = parse(&headers, &body)?;
            Ok(Json(baseline(
                args.project_id,
                stored(&app, &user, args.project_id).await?,
            ))
            .into_response())
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
            Ok(Json(baseline(id, project)).into_response())
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
            if matches!(
                args.command,
                mindgrab_state::Command::SetSaving { cloud: false, .. }
            ) {
                return Err(ApiError::invalid());
            }
            Ok(Json(baseline(
                args.project_id,
                merge(
                    &app,
                    &user,
                    args.project_id,
                    Bytes::new(),
                    Some(args.command),
                )
                .await?,
            ))
            .into_response())
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
) -> Result<Stored> {
    let permit = app.compute.acquire(user.id).await?;
    for _ in 0..MERGE_ATTEMPTS {
        let current = stored(app, user, id).await?;
        let (prior, bytes, command) = (current.snapshot, bytes.clone(), command.clone());
        let (snapshot, name, changed) = compute::run(&permit, move || {
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
            if !view.saving.cloud {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "cloud_disabled",
                ));
            }
            let changed = prior.is_none() || before != project.version();
            let snapshot = match prior {
                Some(prior) if !changed => prior,
                _ => project.snapshot()?,
            };
            Ok((snapshot, view.name, changed))
        })
        .await?;
        if !changed {
            return Ok(Stored {
                snapshot: Some(snapshot),
                revision: current.revision,
            });
        }
        let revision = current.revision + 1;
        let mut tx = app.pool.begin().await?;
        let saved = sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=$3,name=$4,revision=$5,updated_at=now() WHERE id=$1 AND owner_id=$2 AND NOT deleted AND revision=$6").bind(id).bind(user.id).bind(&snapshot).bind(name).bind(revision).bind(current.revision).execute(&mut *tx).await?.rows_affected();
        if saved == 1 {
            notify(&mut tx, user.id, id).await?;
            tx.commit().await?;
            return Ok(Stored {
                snapshot: Some(snapshot),
                revision,
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
    stored(&app, &user, id).await?;
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
                match stored(&app, &user, id).await {
                    Ok(project) => Ok(project.revision),
                    Err(_) => Err("Project unavailable"),
                }
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
    let mut value = baseline(
        project.id,
        Stored {
            snapshot: project.view,
            revision: project.revision,
        },
    );
    value["name"] = json!(project.name);
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
