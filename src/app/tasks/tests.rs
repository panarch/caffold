use std::{sync::Arc, time::Duration};

use axum::http::StatusCode;
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

use super::{routes::*, *};
use crate::{
    app::error::ApiError,
    codex_app_server::{self, CodexPermissionMode, CodexThreadClient},
    codex_thread_sessions::CodexThreadSessions,
    fs::RootedFs,
    task_store::TaskStore,
};

mod detail;
mod projection;
mod runtime;
pub(super) mod support;
mod sync;
