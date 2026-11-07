use crate::{
    AppState, Backend,
    auth::User,
    error::{ApiError, Result},
};
use axum::{
    Json,
    body::Bytes,
    extract::{
        Path, Query, RawQuery, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use std::time::Duration;
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
        Html("<html><body><h1>It works!</h1></body></html>\n").into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
pub async fn health(axum::extract::State(app): AppState) -> Response {
    let started = std::time::Instant::now();
    let healthy = database_ready(&app).await;
    let ms = started.elapsed().as_secs_f64() * 1000.;
    let mut response = (if healthy {StatusCode::OK} else {StatusCode::SERVICE_UNAVAILABLE},Json(json!({"status":if healthy {"ok"} else {"degraded"},"database":{"status":if healthy {"up"} else {"down"},"latency_ms":if healthy {Some(ms)} else {None}}}))).into_response();
    response.headers_mut().insert(
        "server-timing.php",
        format!("db;dur={ms:.3}").parse().unwrap(),
    );
    response
}
pub async fn rpc(
    axum::extract::State(app): AppState,
    method: &'static str,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Response> {
    match method {
        "getHealth" => return Ok(health(axum::extract::State(app)).await),
        "startLogin" => return app.auth.start(&headers).await,
        "logout" => return app.auth.logout(&headers).await,
        "getMe" => return Ok(Json(app.auth.identify(&headers).await?).into_response()),
        // Anyone holding a share token may read; no session is involved.
        "getSharedProject" => return shared(&app, &headers, &body).await,
        "createProject" | "deleteProject" | "mergeProject" | "commandProject" | "setShareLink" => {
            app.config.same_origin(&headers)?
        }
        "listProjects" | "getProjectSnapshot" | "getProjectState" | "getShareLink" => {}
        _ => return Ok(StatusCode::NOT_FOUND.into_response()),
    }
    let user = app.auth.identify(&headers).await?;
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
            sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=NULL,name=NULL,share_token=NULL,deleted=true,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(args.project_id).bind(user.id).execute(&mut *tx).await?;
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
            // disabling discards it so a later link is a new one.
            let mut tx = app.pool.begin().await?;
            let token: Option<String> = sqlx::query_scalar("UPDATE mindgrab_loro.projects SET share_token=CASE WHEN $3 THEN COALESCE(share_token,$4) END WHERE id=$1 AND owner_id=$2 AND NOT deleted RETURNING share_token").bind(args.project_id).bind(user.id).bind(args.enabled).bind(crate::auth::token()).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
            // Wake open viewers so a revoked link closes promptly. This uses
            // its own channel: the content did not change, so the owner's
            // editors have nothing to sync.
            publish(&mut tx, format!("share/{}/{}", user.id, args.project_id)).await?;
            tx.commit().await?;
            Ok(Json(json!({"projectId":args.project_id,"token":token})).into_response())
        }
        "getProjectState" => {
            let args: ProjectId = parse(&headers, &body)?;
            let bytes = stored(&app, &user, args.project_id)
                .await?
                .snapshot
                .ok_or_else(ApiError::missing)?;
            let view = tokio::task::spawn_blocking(move || {
                mindgrab_state::Project::from_snapshot(&bytes)?.view()
            })
            .await
            .map_err(|_| ApiError::unavailable())??;
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
            let project = merge(&app, &user, id, body.to_vec(), None).await?;
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
                merge(&app, &user, args.project_id, vec![], Some(args.command)).await?,
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
async fn merge(
    app: &Backend,
    user: &User,
    id: Uuid,
    bytes: Vec<u8>,
    command: Option<mindgrab_state::Command>,
) -> Result<Stored> {
    let mut tx = app.pool.begin().await?;
    let current: Stored = sqlx::query_as("SELECT snapshot,revision FROM mindgrab_loro.projects WHERE id=$1 AND owner_id=$2 AND NOT deleted FOR UPDATE").bind(id).bind(user.id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
    let prior = current.snapshot;
    let (snapshot, name, changed) = tokio::task::spawn_blocking(move || -> Result<_> {
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
        Ok((
            project.snapshot()?,
            view.name,
            prior.is_none() || before != project.version(),
        ))
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    let revision = current.revision + i64::from(changed);
    if changed {
        sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=$3,name=$4,revision=$5,updated_at=now() WHERE id=$1 AND owner_id=$2").bind(id).bind(user.id).bind(&snapshot).bind(name).bind(revision).execute(&mut *tx).await?;
        notify(&mut tx, user.id, id).await?;
    }
    tx.commit().await?;
    Ok(Stored {
        snapshot: Some(snapshot),
        revision,
    })
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
    snapshot: Option<Vec<u8>>,
    revision: i64,
}
async fn shared_project(app: &Backend, token: &str) -> Result<Shared> {
    // Tokens are 32 random bytes, URL-safe base64 without padding.
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::missing());
    }
    sqlx::query_as("SELECT id,owner_id,name,snapshot,revision FROM mindgrab_loro.projects WHERE share_token=$1 AND NOT deleted AND snapshot IS NOT NULL").bind(token).fetch_optional(&app.pool).await?.ok_or_else(ApiError::missing)
}
async fn shared(app: &Backend, headers: &HeaderMap, body: &Bytes) -> Result<Response> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Args {
        token: String,
    }
    let args: Args = parse(headers, body)?;
    let project = shared_project(app, &args.token).await?;
    let mut value = baseline(
        project.id,
        Stored {
            snapshot: project.snapshot,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        analytics::Analytics,
        auth::Auth,
        config::{AuthMode, Config},
    };
    use axum::extract::State;
    use sqlx::postgres::PgPoolOptions;
    use std::sync::Arc;

    #[tokio::test]
    async fn an_unknown_method_gets_the_page_every_other_missing_path_gets() {
        let config = Config {
            auth_mode: AuthMode::Local,
            database_url: "postgres://postgres@localhost/unused".into(),
            client_id: String::new(),
            api_key: String::new(),
            redirect_uri: "http://localhost:5173/api/auth/callback.php".into(),
            app_url: "http://localhost:5173/".into(),
            issuer: String::new(),
            provider_url: String::new(),
            secure_cookies: false,
            posthog: None,
        };
        // Never connects: the dispatch answers before it touches the database.
        let pool = PgPoolOptions::new()
            .connect_lazy(&config.database_url)
            .unwrap();
        let app = Arc::new(Backend {
            auth: Auth::new(pool.clone(), config.clone()),
            analytics: Analytics::new(None),
            pool,
            config,
            changes: tokio::sync::broadcast::channel(1).0,
        });
        let unknown = rpc(
            State(app),
            "getPassword",
            HeaderMap::new(),
            RawQuery(None),
            Bytes::new(),
        )
        .await
        .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    }
}
