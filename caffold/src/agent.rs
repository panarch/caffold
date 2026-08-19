//! The agents Caffold drives, and how each one is reached.
//!
//! Caffold does not reimplement what an agent does. Each vendor ships a model
//! and a harness built to go with it, and a driver here exists to run that
//! combination the way its authors intended and hand the result to the Tasks
//! application to present.
//!
//! One driver per agent, each owning the way it reaches its own: Codex through
//! its app-server daemon, and — as this grows — Claude through the runner that
//! supervises its sessions.

pub(crate) mod codex;
