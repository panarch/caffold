use std::{net::IpAddr, path::PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};
use tracing_subscriber::EnvFilter;

use crate::{
    app::{self, ServeConfig, VoiceAcceleration},
    tailscale,
};

#[derive(Debug, Parser)]
#[command(name = "caffold")]
#[command(about = "A browser-based review and control surface for agent-assisted development")]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the Caffold web console.
    Serve(ServeArgs),

    /// Configure optional tailnet-only remote access through Tailscale Serve.
    Tailscale(TailscaleArgs),
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum WhisperAcceleration {
    /// Use the platform GPU backend when available and fall back to CPU.
    Auto,
    /// Disable GPU initialization and run Whisper on CPU.
    Cpu,
}

impl From<WhisperAcceleration> for VoiceAcceleration {
    fn from(value: WhisperAcceleration) -> Self {
        match value {
            WhisperAcceleration::Auto => Self::Auto,
            WhisperAcceleration::Cpu => Self::Cpu,
        }
    }
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

    /// Whisper acceleration policy.
    #[arg(long, value_enum, default_value_t = WhisperAcceleration::Auto)]
    whisper_acceleration: WhisperAcceleration,
}

#[derive(Debug, Args)]
struct TailscaleArgs {
    #[command(subcommand)]
    command: TailscaleCommand,
}

#[derive(Debug, Subcommand)]
enum TailscaleCommand {
    /// Configure persistent HTTPS access for this Caffold server.
    Enable(TailscaleOptions),
    /// Report connectivity and whether this Caffold target owns HTTPS Serve.
    Status(TailscaleOptions),
    /// Disable HTTPS Serve only when it is owned by this Caffold target.
    Disable(TailscaleOptions),
}

#[derive(Debug, Args)]
struct TailscaleOptions {
    /// Local Caffold URL to expose.
    #[arg(long, default_value = tailscale::DEFAULT_TARGET)]
    target: String,

    /// Print machine-readable JSON.
    #[arg(long)]
    json: bool,
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
                worktree_root: args.worktree_root,
                voice_acceleration: args.whisper_acceleration.into(),
            })
            .await
        }
        Command::Tailscale(args) => {
            let options = match &args.command {
                TailscaleCommand::Enable(options)
                | TailscaleCommand::Status(options)
                | TailscaleCommand::Disable(options) => options,
            };
            let status = match args.command {
                TailscaleCommand::Enable(_) => tailscale::enable(&options.target)?,
                TailscaleCommand::Status(_) => tailscale::status(&options.target)?,
                TailscaleCommand::Disable(_) => tailscale::disable(&options.target)?,
            };
            tailscale::print_status(&status, options.json)?;
            Ok(())
        }
    }
}
