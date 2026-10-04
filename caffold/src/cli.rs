use std::{net::IpAddr, path::PathBuf, process::ExitCode};

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    app::{self, ServeConfig},
    update::{self, UpdateRequest},
};

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
    /// Update the installed Caffold app with Homebrew, and put the current
    /// version back if the new one does not start.
    Update(UpdateArgs),
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

    /// The Caffold Server app running this server. Only such a server offers
    /// to update the app.
    #[arg(long, value_name = "PATH")]
    app_bundle: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct UpdateArgs {
    /// The installed Caffold Server app.
    #[arg(long, value_name = "PATH")]
    app: PathBuf,

    /// The data directory of the app's server. Attempts are recorded in its
    /// caffold-updates directory.
    #[arg(long, value_name = "PATH")]
    data_dir: PathBuf,

    /// The port of the app's server.
    #[arg(long)]
    port: u16,

    /// The menu-bar app started this update and shows its result.
    #[arg(long)]
    from_menu_bar: bool,

    /// The recorded attempt to run; `caffold update` starts itself with it.
    #[arg(long, value_name = "ID", hide = true)]
    attempt: Option<String>,
}

/// axum reports a connection it failed to accept, such as when the server has
/// run out of file descriptors, only through its own log.
const DEFAULT_LOG_FILTER: &str = "caffold=info,axum::serve=error";

pub async fn run() -> anyhow::Result<ExitCode> {
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
                app_bundle: args.app_bundle,
            })
            .await?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Update(args) => Ok(update::run(
            UpdateRequest {
                app: args.app,
                data_dir: args.data_dir,
                port: args.port,
                from_menu_bar: args.from_menu_bar,
            },
            args.attempt,
        )
        .await),
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

    #[test]
    fn serves_for_the_app_that_names_itself() {
        let cli = Cli::try_parse_from([
            "caffold",
            "serve",
            "--port",
            "5178",
            "--app-bundle",
            "/Applications/Caffold Server.app",
        ])
        .unwrap();

        let Command::Serve(args) = cli.command else {
            panic!("expected serve");
        };
        assert_eq!(
            args.app_bundle,
            Some(PathBuf::from("/Applications/Caffold Server.app"))
        );
        let Command::Serve(args) = Cli::try_parse_from(["caffold", "serve"]).unwrap().command
        else {
            panic!("expected serve");
        };
        assert_eq!(args.app_bundle, None);
    }

    #[test]
    fn reads_an_update_request() {
        let cli = Cli::try_parse_from([
            "caffold",
            "update",
            "--app",
            "/Applications/Caffold Server.app",
            "--data-dir",
            "/Users/me/Library/Application Support/Caffold/data",
            "--port",
            "5178",
            "--from-menu-bar",
        ])
        .unwrap();

        let Command::Update(args) = cli.command else {
            panic!("expected update");
        };
        assert_eq!(args.app, PathBuf::from("/Applications/Caffold Server.app"));
        assert_eq!(
            args.data_dir,
            PathBuf::from("/Users/me/Library/Application Support/Caffold/data")
        );
        assert_eq!(args.port, 5178);
        assert!(args.from_menu_bar);
        assert_eq!(args.attempt, None);
    }

    #[test]
    fn needs_the_app_its_data_and_its_port_to_update() {
        for missing in [
            ["caffold", "update", "--data-dir", "/data", "--port", "5178"],
            ["caffold", "update", "--app", "/A.app", "--port", "5178"],
            [
                "caffold",
                "update",
                "--app",
                "/A.app",
                "--data-dir",
                "/data",
            ],
        ] {
            assert!(Cli::try_parse_from(missing).is_err());
        }
    }
}
