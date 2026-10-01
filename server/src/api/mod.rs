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

use axum::{Router, middleware, routing::post};
use serde::Deserialize;

use crate::auth::{AppState, private_response};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct ProjectRequest {
    project_id: String,
}

pub(crate) fn router(state: Arc<AppState>) -> Router {
    let methods = Router::new()
        .route("/getMe", post(get_me::get_me))
        .route("/getHealth", post(get_health::get_health))
        .route("/startLogin", post(start_login::start_login))
        .route("/logout", post(logout::logout))
        .route("/createProject", post(create_project::create_project))
        .route("/listProjects", post(list_projects::list_projects))
        .route("/getProject", post(get_project::get_project))
        .route(
            "/getProjectBaseline",
            post(get_project_baseline::get_project_baseline),
        )
        .route(
            "/getProjectUpdates",
            post(get_project_updates::get_project_updates),
        )
        .route(
            "/getProjectStatus",
            post(get_project_status::get_project_status),
        )
        .route(
            "/getProjectState",
            post(get_project_state::get_project_state),
        )
        .route(
            "/submitProjectUpdate",
            post(submit_project_update::submit_project_update),
        )
        .layer(middleware::from_fn(private_response));
    Router::new().nest("/api", methods).with_state(state)
}

#[cfg(test)]
mod tests;
