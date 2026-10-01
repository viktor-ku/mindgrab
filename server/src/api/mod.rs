//! Public RPC methods. Each POST /api/<function> has a matching source file.

#[path = "createProject.rs"]
mod create_project;
#[path = "getHealth.rs"]
mod get_health;
#[path = "getMe.rs"]
mod get_me;
#[path = "getProject.rs"]
mod get_project;
#[path = "getProjectBaseline.rs"]
mod get_project_baseline;
#[path = "getProjectState.rs"]
mod get_project_state;
#[path = "getProjectStatus.rs"]
mod get_project_status;
#[path = "getProjectUpdates.rs"]
mod get_project_updates;
#[path = "listProjects.rs"]
mod list_projects;
#[path = "logout.rs"]
mod logout;
#[path = "startLogin.rs"]
mod start_login;
#[path = "submitProjectUpdate.rs"]
mod submit_project_update;

use std::sync::Arc;

use axum::{Router, http::StatusCode, response::IntoResponse, routing::post};
use serde::Deserialize;

use crate::{
    auth::{self, AppState},
    project::{self, ApiError},
    request_validation::same_origin,
    response_headers::private_headers,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct ProjectRequest {
    project_id: String,
}

pub(crate) fn router(state: Arc<AppState>) -> Router {
    let auth_origin = same_origin(state.config.origin(), || {
        (StatusCode::FORBIDDEN, "Invalid request origin").into_response()
    });
    let project_origin = same_origin(state.config.origin(), || {
        ApiError::InvalidOrigin.into_response()
    });
    let project = |route| project::protect(route, state.clone());
    let auth = |route, key| {
        auth::manage(
            route,
            state.clone(),
            key,
            crate::workos::AuthError::into_response,
        )
    };
    let methods = Router::new()
        .route("/getMe", auth(post(get_me::get_me), auth::AUTH_DATA))
        .route("/getHealth", post(get_health::get_health))
        .route(
            "/startLogin",
            post(start_login::start_login).route_layer(auth_origin.clone()),
        )
        // An empty identification key lets explicit logout work during WorkOS
        // outages; AuthSession still flushes the provider-backed durable record.
        .route(
            "/logout",
            auth(post(logout::logout), "logout").route_layer(auth_origin),
        )
        .route(
            "/createProject",
            project(post(create_project::create_project)).route_layer(project_origin.clone()),
        )
        .route("/listProjects", project(post(list_projects::list_projects)))
        .route("/getProject", project(post(get_project::get_project)))
        .route(
            "/getProjectBaseline",
            project(post(get_project_baseline::get_project_baseline)),
        )
        .route(
            "/getProjectUpdates",
            project(post(get_project_updates::get_project_updates)),
        )
        .route(
            "/getProjectStatus",
            project(post(get_project_status::get_project_status)),
        )
        .route(
            "/getProjectState",
            project(post(get_project_state::get_project_state)),
        )
        .route(
            "/submitProjectUpdate",
            project(submit_project_update::route()).route_layer(project_origin),
        )
        .layer(private_headers());
    Router::new().nest("/api", methods).with_state(state)
}

#[cfg(test)]
mod tests;
