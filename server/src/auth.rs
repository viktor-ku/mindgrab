use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    config::Config,
    workos::{AuthError, WorkOs, WorkOsUser},
};

const SESSION_COOKIE: &str = "mindgrab_session";
const STATE_COOKIE: &str = "mindgrab_login";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub workos: WorkOs,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth/login", get(login))
        .route("/api/auth/callback", get(callback))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(current_user))
        .route("/api/projects", get(list_projects).put(save_project))
        .layer(middleware::from_fn(private_response))
        .with_state(state)
}

async fn private_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "Invalid project."),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Sign in to continue."),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Authentication is temporarily unavailable. Please retry.",
            ),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(_: sqlx::Error) -> Self {
        // Do not log queries, token payloads, credentials, or provider responses.
        eprintln!("Authentication database operation failed");
        Self::Unavailable
    }
}

fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn token_hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn cookie(config: &Config, name: &'static str, value: String, seconds: i64) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.secure_cookies)
        .max_age(time::Duration::seconds(seconds))
        .build()
}

fn clear_cookie(jar: CookieJar, config: &Config, name: &'static str) -> CookieJar {
    jar.add(cookie(config, name, String::new(), 0))
}

async fn login(State(state): State<Arc<AppState>>, jar: CookieJar) -> Result<Response, AuthError> {
    let nonce = random_token();
    let verifier = random_token();
    // Replace the previous attempt for this browser when restarting sign-in.
    if let Some(previous) = jar.get(STATE_COOKIE) {
        sqlx::query("DELETE FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(previous.value()))
            .execute(&state.pool)
            .await?;
    }
    sqlx::query("INSERT INTO auth_login_attempts (state_hash, code_verifier) VALUES ($1, $2)")
        .bind(token_hash(&nonce))
        .bind(&verifier)
        .execute(&state.pool)
        .await?;
    let url =
        state
            .workos
            .authorization_url(&state.config.redirect_uri, &nonce, &token_hash(&verifier));
    let jar = jar.add(cookie(&state.config, STATE_COOKIE, nonce, 600));
    Ok((jar, Redirect::to(url.as_str())).into_response())
}

#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(query): Query<Callback>,
) -> Response {
    let result = finish_login(&state, &jar, query).await;
    let jar = clear_cookie(jar, &state.config, STATE_COOKIE);
    match result {
        Ok(token) => (
            jar.add(cookie(
                &state.config,
                SESSION_COOKIE,
                token,
                SESSION_SECONDS,
            )),
            Redirect::to(&state.config.app_url),
        )
            .into_response(),
        Err(error) => {
            let code = match error {
                AuthError::BadRequest => "sign_in_failed",
                AuthError::Unauthorized => "sign_in_failed",
                AuthError::Unavailable => "unavailable",
            };
            (
                jar,
                Redirect::to(&format!("{}?auth_error={code}", state.config.app_url)),
            )
                .into_response()
        }
    }
}

async fn finish_login(
    state: &AppState,
    jar: &CookieJar,
    query: Callback,
) -> Result<String, AuthError> {
    let nonce = query
        .state
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            eprintln!("Auth callback rejected: missing state");
            AuthError::Unauthorized
        })?;
    let browser_nonce = jar.get(STATE_COOKIE).ok_or_else(|| {
        eprintln!("Auth callback rejected: missing login cookie");
        AuthError::Unauthorized
    })?;
    if token_hash(&nonce) != token_hash(browser_nonce.value()) {
        eprintln!("Auth callback rejected: state does not match login cookie");
        return Err(AuthError::Unauthorized);
    }
    // DELETE ... RETURNING makes attempts one-use, even for concurrent callbacks.
    let verifier: Option<String> = sqlx::query_scalar(
        "DELETE FROM auth_login_attempts WHERE state_hash = $1 AND expires_at > NOW() RETURNING code_verifier",
    ).bind(token_hash(&nonce)).fetch_optional(&state.pool).await?;
    let verifier = verifier.ok_or_else(|| {
        eprintln!("Auth callback rejected: login attempt expired or already consumed");
        AuthError::Unauthorized
    })?;
    if query.error.is_some() {
        eprintln!("Auth callback rejected: provider returned an error");
        return Err(AuthError::Unauthorized);
    }
    let code = query
        .code
        .filter(|value| !value.is_empty())
        .ok_or(AuthError::Unauthorized)?;
    let authentication = state
        .workos
        .exchange(&code, &verifier)
        .await
        .inspect_err(|_| {
            eprintln!("Auth callback failed during code exchange");
        })?;
    let claims = state
        .workos
        .verify(&authentication.access_token)
        .await
        .inspect_err(|_| {
            eprintln!("Auth callback failed during access token validation");
        })?;
    if claims.exp <= jsonwebtoken::get_current_timestamp() || claims.sub != authentication.user.id {
        return Err(AuthError::Unauthorized);
    }
    let token = random_token();
    let mut tx = state.pool.begin().await?;
    let user = upsert_user(&mut tx, &authentication.user).await?;
    // Rotate the local session credential on every successful login.
    if let Some(previous) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
            .bind(token_hash(previous.value()))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token) VALUES ($1, $2, $3, $4, $5)")
        .bind(token_hash(&token)).bind(user.id).bind(claims.sid)
        .bind(authentication.access_token).bind(authentication.refresh_token)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(token)
}

#[derive(Serialize, sqlx::FromRow)]
struct User {
    id: i64,
    name: String,
    email: String,
    external_id: String,
}

async fn upsert_user(
    tx: &mut Transaction<'_, Postgres>,
    user: &WorkOsUser,
) -> Result<User, AuthError> {
    Ok(sqlx::query_as("INSERT INTO users (name, email, external_id) VALUES ($1, $2, $3) ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email RETURNING id, name, email, external_id")
        .bind(user.name()).bind(&user.email).bind(&user.id).fetch_one(&mut **tx).await?)
}

#[derive(sqlx::FromRow)]
struct Session {
    user_id: i64,
    workos_session_id: String,
    access_token: String,
    refresh_token: String,
}

async fn current_user(State(state): State<Arc<AppState>>, jar: CookieJar) -> Response {
    match authenticated_user(&state, &jar).await {
        Ok(user) => Json(user).into_response(),
        Err(AuthError::Unauthorized) => (
            clear_cookie(jar, &state.config, SESSION_COOKIE),
            AuthError::Unauthorized,
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

async fn authenticated_user(state: &AppState, jar: &CookieJar) -> Result<User, AuthError> {
    let token = jar.get(SESSION_COOKIE).ok_or(AuthError::Unauthorized)?;
    let hash = token_hash(token.value());
    let mut tx = state.pool.begin().await?;
    // Lock this session during refresh so concurrent requests never race rotation.
    let session: Option<Session> = sqlx::query_as("SELECT user_id, workos_session_id, access_token, refresh_token FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE")
        .bind(&hash).fetch_optional(&mut *tx).await?;
    let session = session.ok_or(AuthError::Unauthorized)?;
    let result = validate_session(state, &mut tx, &hash, session).await;
    if matches!(result, Err(AuthError::Unauthorized)) {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }
    // Preserve sessions on transient provider failures; no stale token is accepted.
    tx.commit().await?;
    result
}

#[derive(Serialize)]
struct ProjectRecord {
    name: String,
    state: Value,
    updated_at: String,
}

#[derive(Deserialize)]
struct ProjectState {
    version: u8,
    nodes: Vec<ProjectNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor: Option<ProjectAnchor>,
    view: ProjectView,
}

#[derive(Deserialize)]
struct ProjectNode {
    id: Uuid,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<NodePosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next: Option<Vec<ProjectNode>>,
}

#[derive(Deserialize)]
struct NodePosition {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct ProjectAnchor {
    id: Uuid,
    #[serde(rename = "centerY")]
    center_y: f64,
}

#[derive(Deserialize)]
struct ProjectView {
    left: f64,
    top: f64,
    zoom: f64,
}

#[derive(Deserialize)]
struct SaveProject {
    name: String,
    state: Value,
}

#[derive(sqlx::FromRow)]
struct StoredProject {
    id: i64,
    name: String,
    state: Value,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct StoredPNode {
    project_id: i64,
    id: Uuid,
    text: String,
    sort_order: i64,
    position_x: Option<f64>,
    position_y: Option<f64>,
    parent_pnode_id: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct SavedProject {
    id: i64,
    updated_at: String,
}

struct NewPNode<'a> {
    node: &'a ProjectNode,
    parent_pnode_id: Option<Uuid>,
    sort_order: i64,
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<ProjectRecord>>, AuthError> {
    let user = authenticated_user(&state, &jar).await?;
    Ok(Json(load_projects(&state.pool, user.id).await?))
}

async fn save_project(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(project): Json<SaveProject>,
) -> Result<Json<ProjectRecord>, AuthError> {
    let user = authenticated_user(&state, &jar).await?;
    let name = project.name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(AuthError::BadRequest);
    }
    let state_value = project.state;
    let project_state: ProjectState =
        serde_json::from_value(state_value.clone()).map_err(|_| AuthError::BadRequest)?;
    if !valid_project_state(&project_state) {
        return Err(AuthError::BadRequest);
    }
    let mut state_metadata = state_value.clone();
    state_metadata
        .as_object_mut()
        .ok_or(AuthError::BadRequest)?
        .remove("nodes");

    let mut new_nodes = Vec::new();
    flatten_pnodes(&project_state.nodes, None, &mut new_nodes);
    let node_ids = new_nodes
        .iter()
        .map(|entry| entry.node.id)
        .collect::<Vec<_>>();
    let mut tx = state.pool.begin().await?;
    let saved: SavedProject = sqlx::query_as(
        "INSERT INTO project (user_id, name, state) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW() RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at",
    )
    .bind(user.id)
    .bind(name)
    .bind(state_metadata)
    .fetch_one(&mut *tx)
    .await?;

    for entry in &new_nodes {
        let position_x = entry.node.position.as_ref().map(|position| position.x);
        let position_y = entry.node.position.as_ref().map(|position| position.y);
        sqlx::query(
            "INSERT INTO pnode (id, user_id, project_id, text, parent_pnode_id, sort_order, position_x, position_y) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (project_id, id) DO UPDATE SET text = EXCLUDED.text, parent_pnode_id = EXCLUDED.parent_pnode_id, sort_order = EXCLUDED.sort_order, position_x = EXCLUDED.position_x, position_y = EXCLUDED.position_y, updated_at = NOW()",
        )
        .bind(entry.node.id)
        .bind(user.id)
        .bind(saved.id)
        .bind(&entry.node.text)
        .bind(entry.parent_pnode_id)
        .bind(entry.sort_order)
        .bind(position_x)
        .bind(position_y)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("DELETE FROM pnode WHERE project_id = $1 AND id <> ALL($2)")
        .bind(saved.id)
        .bind(node_ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(ProjectRecord {
        name: name.to_owned(),
        state: state_value,
        updated_at: saved.updated_at,
    }))
}

async fn load_projects(pool: &PgPool, user_id: i64) -> Result<Vec<ProjectRecord>, AuthError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let projects = sqlx::query_as::<_, StoredProject>(
        "SELECT id, name, state, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM project WHERE user_id = $1 ORDER BY name",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let pnodes = sqlx::query_as::<_, StoredPNode>(
        "SELECT project_id, id, text, sort_order, position_x, position_y, parent_pnode_id FROM pnode WHERE user_id = $1 ORDER BY project_id, parent_pnode_id NULLS FIRST, sort_order, id",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut pnodes_by_project = HashMap::<i64, Vec<StoredPNode>>::new();
    for pnode in pnodes {
        pnodes_by_project
            .entry(pnode.project_id)
            .or_default()
            .push(pnode);
    }
    Ok(projects
        .into_iter()
        .map(|project| {
            let pnodes = pnodes_by_project.remove(&project.id).unwrap_or_default();
            project_record(project, pnodes)
        })
        .collect())
}

fn project_record(project: StoredProject, pnodes: Vec<StoredPNode>) -> ProjectRecord {
    let mut children_by_parent = HashMap::<Option<Uuid>, Vec<StoredPNode>>::new();
    for pnode in pnodes {
        children_by_parent
            .entry(pnode.parent_pnode_id)
            .or_default()
            .push(pnode);
    }
    let mut roots = children_by_parent.remove(&None).unwrap_or_default();
    roots.sort_by_key(|pnode| (pnode.sort_order, pnode.id));
    let nodes: Vec<Value> = roots
        .into_iter()
        .map(|root| project_node_value(root, &mut children_by_parent))
        .collect();
    let mut state = project.state;
    state["nodes"] = Value::Array(nodes);

    ProjectRecord {
        name: project.name,
        state,
        updated_at: project.updated_at,
    }
}

fn project_node_value(
    pnode: StoredPNode,
    children_by_parent: &mut HashMap<Option<Uuid>, Vec<StoredPNode>>,
) -> Value {
    let mut children = children_by_parent
        .remove(&Some(pnode.id))
        .unwrap_or_default();
    children.sort_by_key(|pnode| (pnode.sort_order, pnode.id));
    let next = children
        .into_iter()
        .map(|child| project_node_value(child, children_by_parent))
        .collect::<Vec<_>>();
    let position = pnode
        .position_x
        .zip(pnode.position_y)
        .map(|(x, y)| json!({"x": json_number(x), "y": json_number(y)}));
    let mut node = json!({"id": pnode.id.to_string(), "text": pnode.text});
    if let Some(position) = position {
        node["position"] = position;
    }
    if !next.is_empty() {
        node["next"] = Value::Array(next);
    }
    node
}

fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn valid_project_state(state: &ProjectState) -> bool {
    state.version == 1
        && state.view.left.is_finite()
        && state.view.top.is_finite()
        && state.view.zoom.is_finite()
        && (0.25..=2.5).contains(&state.view.zoom)
        && state
            .anchor
            .as_ref()
            .is_none_or(|anchor| !anchor.id.is_nil() && anchor.center_y.is_finite())
        && valid_pnodes(&state.nodes, 0, &mut HashSet::new())
}

fn valid_pnodes(nodes: &[ProjectNode], depth: usize, ids: &mut HashSet<Uuid>) -> bool {
    if depth >= 100 {
        return false;
    }
    nodes.iter().all(|node| {
        ids.insert(node.id)
            && node
                .position
                .as_ref()
                .is_none_or(|position| position.x.is_finite() && position.y.is_finite())
            && valid_pnodes(node.next.as_deref().unwrap_or_default(), depth + 1, ids)
    })
}

fn flatten_pnodes<'a>(
    nodes: &'a [ProjectNode],
    parent_pnode_id: Option<Uuid>,
    flattened: &mut Vec<NewPNode<'a>>,
) {
    for (sort_order, node) in nodes.iter().enumerate() {
        flattened.push(NewPNode {
            node,
            parent_pnode_id,
            sort_order: sort_order as i64,
        });
        flatten_pnodes(
            node.next.as_deref().unwrap_or_default(),
            Some(node.id),
            flattened,
        );
    }
}

async fn validate_session(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    hash: &str,
    session: Session,
) -> Result<User, AuthError> {
    let claims = state.workos.verify(&session.access_token).await?;
    let user: User = sqlx::query_as("SELECT id, name, email, external_id FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_one(&mut **tx)
        .await?;
    if claims.sub != user.external_id || claims.sid != session.workos_session_id {
        return Err(AuthError::Unauthorized);
    }
    if claims.exp > jsonwebtoken::get_current_timestamp() + 30 {
        return Ok(user);
    }
    let authentication = state.workos.refresh(&session.refresh_token).await?;
    let refreshed = state.workos.verify(&authentication.access_token).await?;
    if refreshed.exp <= jsonwebtoken::get_current_timestamp()
        || refreshed.sub != user.external_id
        || refreshed.sid != session.workos_session_id
        || authentication.user.id != user.external_id
    {
        return Err(AuthError::Unauthorized);
    }
    sqlx::query(
        "UPDATE auth_sessions SET access_token = $1, refresh_token = $2 WHERE token_hash = $3",
    )
    .bind(authentication.access_token)
    .bind(authentication.refresh_token)
    .bind(hash)
    .execute(&mut **tx)
    .await?;
    upsert_user(tx, &authentication.user).await
}

async fn logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    // A same-origin POST is required; SameSite alone does not protect sibling domains.
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(state.config.origin().as_str())
    {
        return Ok((StatusCode::FORBIDDEN, "Invalid request origin").into_response());
    }
    let mut destination = state.config.app_url.clone();
    if let Some(token) = jar.get(SESSION_COOKIE) {
        let sid: Option<String> = sqlx::query_scalar(
            "DELETE FROM auth_sessions WHERE token_hash = $1 RETURNING workos_session_id",
        )
        .bind(token_hash(token.value()))
        .fetch_optional(&state.pool)
        .await?;
        if let Some(sid) = sid {
            destination = state
                .workos
                .logout_url(&sid, &state.config.app_url)
                .to_string();
        }
    }
    if let Some(nonce) = jar.get(STATE_COOKIE) {
        sqlx::query("DELETE FROM auth_login_attempts WHERE state_hash = $1")
            .bind(token_hash(nonce.value()))
            .execute(&state.pool)
            .await?;
    }
    let jar = clear_cookie(
        clear_cookie(jar, &state.config, SESSION_COOKIE),
        &state.config,
        STATE_COOKIE,
    );
    Ok((jar, Redirect::to(&destination)).into_response())
}

#[cfg(test)]
mod tests;
