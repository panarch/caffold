mod browse;
mod current_plan;
mod git;
mod github;

use std::sync::Arc;

use axum::Router;
use serde::Deserialize;

use crate::fs::RootedFs;

#[derive(Clone)]
struct WorkspaceState {
    fs: Arc<RootedFs>,
}

impl WorkspaceState {
    fn new(fs: Arc<RootedFs>) -> Self {
        Self { fs }
    }
}

#[derive(Debug, Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

pub(super) fn router(fs: Arc<RootedFs>) -> Router {
    let state = WorkspaceState::new(fs);
    Router::new()
        .merge(browse::router())
        .merge(current_plan::router())
        .merge(git::router())
        .merge(github::router())
        .with_state(state)
}
