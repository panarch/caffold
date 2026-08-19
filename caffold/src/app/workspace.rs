mod browse;
mod git;
mod github;
mod watch;

use std::sync::Arc;

use axum::Router;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::{fs::RootedFs, watch::WatchHub};

#[derive(Clone)]
struct WorkspaceState {
    fs: Arc<RootedFs>,
    watch_hub: WatchHub,
    shutdown: broadcast::Sender<()>,
}

impl WorkspaceState {
    fn new(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Self {
        let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
        Self {
            fs,
            watch_hub,
            shutdown,
        }
    }
}

#[derive(Debug, Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

pub(super) fn router(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Router {
    let state = WorkspaceState::new(fs, shutdown);
    Router::new()
        .merge(browse::router())
        .merge(watch::router())
        .merge(git::router())
        .merge(github::router())
        .with_state(state)
}
