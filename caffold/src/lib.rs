pub mod app;
pub mod cli;
pub mod fs;

mod agent;
mod codex_thread_sessions;

// The supported Codex baseline is already part of Caffold's outward contract:
// it is reported by the status API and gates every Task operation. Exposing the
// constant lets the protocol contract in `tests/` assert against the real value
// instead of repeating it.
pub use agent::codex::MINIMUM_SUPPORTED_CODEX_CLI_VERSION;
mod git;
mod github;
mod server_settings;
mod static_assets;
mod task_rollout;
mod task_store;
mod watch;
