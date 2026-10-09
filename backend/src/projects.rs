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
    response::{IntoResponse, Response},
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
pub async fn rpc(
    axum::extract::State(app): AppState,
    Path(method): Path<String>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Response> {
    match method.as_str() {
        "getHealth" => {
            let started = std::time::Instant::now();
            let healthy = matches!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&app.pool)
                )
                .await,
                Ok(Ok(1))
            );
            let ms = started.elapsed().as_secs_f64() * 1000.;
            let mut response = (if healthy {StatusCode::OK} else {StatusCode::SERVICE_UNAVAILABLE},Json(json!({"status":if healthy {"ok"} else {"degraded"},"database":{"status":if healthy {"up"} else {"down"},"latency_ms":if healthy {Some(ms)} else {None}}}))).into_response();
            response
                .headers_mut()
                .insert("server-timing", format!("db;dur={ms:.3}").parse().unwrap());
            return Ok(response);
        }
        "startLogin" => return app.auth.start(&headers).await,
        "logout" => return app.auth.logout(&headers).await,
        "getMe" => return Ok(Json(app.auth.identify(&headers).await?).into_response()),
        "createProject" | "deleteProject" | "mergeProject" | "commandProject" => {
            app.config.same_origin(&headers)?
        }
        "listProjects" | "getProjectSnapshot" | "getProjectState" => {}
        _ => return Ok(StatusCode::NOT_FOUND.into_response()),
    }
    let user = app.auth.identify(&headers).await?;
    match method.as_str() {
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
            sqlx::query("UPDATE mindgrab_loro.projects SET snapshot=NULL,name=NULL,deleted=true,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND NOT deleted").bind(args.project_id).bind(user.id).execute(&mut *tx).await?;
            notify(&mut tx, user.id, args.project_id).await?;
            tx.commit().await?;
            Ok(Json(json!({"deleted":true})).into_response())
        }
        "listProjects" => {
            let args: Page = parse(&headers, &body)?;
            let limit = args.limit.unwrap_or(100);
            if !(1..=100).contains(&limit) {
                return Err(ApiError::invalid());
            }
            let rows: Vec<(Uuid,Option<String>)> = sqlx::query_as("SELECT id,name FROM mindgrab_loro.projects WHERE owner_id=$1 AND NOT deleted AND snapshot IS NOT NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3").bind(user.id).bind(args.cursor).bind(limit+1).fetch_all(&app.pool).await?;
            let cursor = if rows.len() > limit as usize {
                rows.get(limit as usize - 1).map(|row| row.0)
            } else {
                None
            };
            Ok(Json(json!({"projects":rows.into_iter().take(limit as usize).map(|(id,name)|record(id,name)).collect::<Vec<_>>(),"nextCursor":cursor})).into_response())
        }
        "getProjectSnapshot" => {
            let args: ProjectId = parse(&headers, &body)?;
            Ok(Json(baseline(
                args.project_id,
                stored(&app, &user, args.project_id).await?,
            ))
            .into_response())
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
    sqlx::query("SELECT pg_notify('mindgrab_loro',$1)")
        .bind(format!("{owner}/{id}"))
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
    Ok(ws
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| handle_socket(app, socket, headers, user, id, receiver)))
}
async fn handle_socket(
    app: std::sync::Arc<Backend>,
    mut socket: WebSocket,
    headers: HeaderMap,
    user: User,
    id: Uuid,
    mut receiver: tokio::sync::broadcast::Receiver<String>,
) {
    let target = format!("{}/{id}", user.id);
    let mut timer = tokio::time::interval(Duration::from_secs(20));
    loop {
        let changed = tokio::select! {
            received = receiver.recv() => match received { Ok(value) => value==target, Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true, Err(_) => break },
            _ = timer.tick() => true,
            message = socket.recv() => match message { Some(Ok(Message::Ping(bytes))) => {if socket.send(Message::Pong(bytes)).await.is_err(){break;} false}, Some(Ok(Message::Pong(_))) => false, _ => break },
        };
        if !changed {
            continue;
        }
        if app.auth.identify(&headers).await.is_err() {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1008,
                    reason: "Sign in again".into(),
                })))
                .await;
            break;
        }
        let project = match stored(&app, &user, id).await {
            Ok(project) => project,
            Err(_) => {
                let _ = socket
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 1008,
                        reason: "Project unavailable".into(),
                    })))
                    .await;
                break;
            }
        };
        if socket
            .send(Message::Text(
                json!({"revision":project.revision.to_string()})
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }
}
