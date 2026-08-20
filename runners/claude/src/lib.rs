//! Supervising `claude` sessions, and the socket that reaches them.
//!
//! The runner is a process, and this is the library half of it: the wire
//! contract in [`protocol`], the client that speaks it in [`client`], and the
//! server that answers in [`daemon`]. The command line in `main.rs` is one
//! client of this library, and the Caffold backend is the other.
//!
//! Both halves share these types on purpose. A backend that re-derived the
//! request and response shapes would have a second definition of the contract
//! to keep in step, and the first divergence would show up as a frame that
//! silently does nothing rather than as a compiler error.

pub mod client;
pub mod daemon;
pub mod protocol;
mod session;

/// Name of the socket inside the data directory.
///
/// The socket lives with the data rather than at a fixed per-user path so that
/// an installed application, a development server, and a test run each get
/// their own runner for free — the same way they already get their own
/// database. It is named here because a backend that guessed a different name
/// would start a second runner rather than fail to find the first.
pub const SOCKET_NAME: &str = "claude-runner.sock";
