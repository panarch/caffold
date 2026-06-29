use std::{net::IpAddr, path::PathBuf};

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::app::{self, ServeConfig};

#[derive(Debug, Parser)]
#[command(name = "codger")]
#[command(about = "A browser-based review console for agent-generated code")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the Codger web console.
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

    /// Filesystem root boundary to browse. Without this, Codger starts at $HOME and allows parent navigation.
    #[arg(long, value_name = "PATH")]
    root: Option<PathBuf>,
}

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("codger=info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Command::Serve(args) => {
            app::serve(ServeConfig {
                host: args.host,
                port: args.port,
                root: args.root,
            })
            .await
        }
    }
}
