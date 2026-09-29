use std::{net::IpAddr, path::PathBuf};

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::app::{self, ServeConfig};

#[derive(Debug, Parser)]
#[command(name = "caffold")]
#[command(about = "A browser-based review and control surface for agent-assisted development")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the Caffold web console.
    Serve(ServeArgs),
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// Address to bind.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// Port to bind.
    #[arg(long, default_value_t = 5177)]
    port: u16,

    /// Filesystem root boundary to browse. Without this, Caffold starts at $HOME and allows parent navigation.
    #[arg(long, value_name = "PATH")]
    root: Option<PathBuf>,

    /// Directory for Caffold's local metadata database.
    #[arg(long, value_name = "PATH")]
    data_dir: Option<PathBuf>,

    /// Directory exclusively owned by Caffold for managed Git worktrees.
    #[arg(long, value_name = "PATH")]
    worktree_root: Option<PathBuf>,
}

/// axum reports a connection it failed to accept, such as when the server has
/// run out of file descriptors, only through its own log.
const DEFAULT_LOG_FILTER: &str = "caffold=info,axum::serve=error";

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER)),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Command::Serve(args) => {
            app::serve(ServeConfig {
                host: args.host,
                port: args.port,
                root: args.root,
                data_dir: args.data_dir,
                worktree_root: args.worktree_root,
            })
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{Arc, Mutex},
    };

    use super::*;

    /// A writer that keeps what the subscriber prints.
    #[derive(Clone, Default)]
    struct Printed(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Printed {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_default_filter_prints_failed_accepts_among_caffold_messages() {
        let printed = Printed::default();
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(EnvFilter::new(DEFAULT_LOG_FILTER))
            .with_writer({
                let printed = printed.clone();
                move || printed.clone()
            })
            .with_ansi(false)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            // What axum's listener logs when accept fails.
            tracing::error!(
                target: "axum::serve::listener",
                "accept error: Too many open files (os error 24)"
            );
            tracing::info!(target: "caffold::app", "serving Caffold");
            tracing::warn!(target: "axum::serve", "an axum warning");
            tracing::error!(target: "hyper::proto", "a hyper error");
        });

        let printed = String::from_utf8(printed.0.lock().unwrap().clone()).unwrap();
        assert!(
            printed.contains("accept error: Too many open files"),
            "{printed}"
        );
        assert!(printed.contains("serving Caffold"), "{printed}");
        assert!(!printed.contains("an axum warning"), "{printed}");
        assert!(!printed.contains("a hyper error"), "{printed}");
    }
}
