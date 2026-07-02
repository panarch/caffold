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
}

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("caffold=info")),
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
            })
            .await
        }
    }
}
