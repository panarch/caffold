//! Command line for the Caffold Claude runner.
//!
//! The runner's first client is this command line rather than the Caffold
//! backend. Everything the backend will eventually do — start the runner, ask
//! for a session, attach, exchange frames — is reachable from a shell, so the
//! whole surface can be exercised, and a later failure can be reproduced,
//! without a backend in the picture.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;

use clap::{Args, Parser, Subcommand};
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use caffold_claude_runner::client::{self, Client};
use caffold_claude_runner::{SOCKET_NAME, daemon, protocol};
use protocol::{Request, SpawnRequest};

#[derive(Debug, Parser)]
#[command(
    name = "caffold-claude-runner",
    about = "Supervises Claude sessions for Caffold and relays their frames"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Runner process lifecycle.
    #[command(subcommand)]
    Daemon(DaemonCommand),
    /// Session lifecycle.
    #[command(subcommand)]
    Session(SessionCommand),
    /// Exchange frames with a session: stdin is forwarded to it, and everything
    /// it produces is written to stdout.
    Attach(AttachArgs),
}

#[derive(Debug, Subcommand)]
enum DaemonCommand {
    /// Start a runner if one is not already listening.
    Start(DataDirArgs),
    /// Run in the foreground. This is what `start` launches, and what a test
    /// runs directly so it can supervise the process itself.
    Run(DataDirArgs),
    Stop(DataDirArgs),
    Restart(DataDirArgs),
    Status(DataDirArgs),
}

#[derive(Debug, Subcommand)]
enum SessionCommand {
    /// Ensure a session exists, starting it from the given command if it does
    /// not. Repeating the call on a live session is not an error.
    Create(CreateArgs),
    List(DataDirArgs),
    Close(SessionArgs),
}

#[derive(Debug, Args)]
struct DataDirArgs {
    /// Caffold data directory. Defaults to the same location the server uses.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct SessionArgs {
    #[arg(long)]
    session: String,
    #[command(flatten)]
    data: DataDirArgs,
}

#[derive(Debug, Args)]
struct CreateArgs {
    #[arg(long)]
    session: String,
    /// Working directory for the child.
    #[arg(long)]
    cwd: PathBuf,
    /// Extra environment entries, as KEY=VALUE.
    #[arg(long = "env")]
    env: Vec<String>,
    #[command(flatten)]
    data: DataDirArgs,
    /// The command to run, after `--`. The runner passes it through without
    /// interpreting any of it.
    #[arg(last = true, required = true)]
    argv: Vec<String>,
}

#[derive(Debug, Args)]
struct AttachArgs {
    #[arg(long)]
    session: String,
    /// Working directory for a session this command has to create. Defaults to
    /// the current directory.
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[command(flatten)]
    data: DataDirArgs,
    /// A command to start the session with, after `--`. Given one, the session
    /// is created and attached in a single request, so an agent that speaks as
    /// soon as it starts is not talking to nobody. Without one, the session
    /// must already exist.
    #[arg(last = true)]
    argv: Vec<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Daemon(DaemonCommand::Run(args)) => run_foreground(socket_path(&args)?).await,
        Command::Daemon(DaemonCommand::Start(args)) => start(socket_path(&args)?).await,
        Command::Daemon(DaemonCommand::Stop(args)) => stop(socket_path(&args)?).await,
        Command::Daemon(DaemonCommand::Restart(args)) => {
            let socket = socket_path(&args)?;
            stop(socket.clone()).await.ok();
            start(socket).await
        }
        Command::Daemon(DaemonCommand::Status(args)) => status(socket_path(&args)?).await,
        Command::Session(SessionCommand::Create(args)) => create(args).await,
        Command::Session(SessionCommand::List(args)) => list(socket_path(&args)?).await,
        Command::Session(SessionCommand::Close(args)) => close(args).await,
        Command::Attach(args) => attach(args).await,
    }
}

fn socket_path(args: &DataDirArgs) -> anyhow::Result<PathBuf> {
    let data_dir = match &args.data_dir {
        Some(explicit) => explicit.clone(),
        None => default_data_dir()?,
    };
    Ok(data_dir.join(SOCKET_NAME))
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
    Ok(home.join(".caffold"))
}

async fn run_foreground(socket: PathBuf) -> anyhow::Result<()> {
    let listener = daemon::bind(&socket).await?;
    let runner = daemon::Runner::new(socket);
    runner.serve(listener).await
}

/// Idempotent, like the session lifecycle one level down: asking for a runner
/// that already exists reports the existing one rather than failing.
async fn start(socket: PathBuf) -> anyhow::Result<()> {
    if daemon::is_running(&socket).await {
        println!("alreadyRunning {}", socket.display());
        return Ok(());
    }
    if let Some(parent) = socket.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let executable = std::env::current_exe()?;
    let mut command = std::process::Command::new(executable);
    command
        .arg("daemon")
        .arg("run")
        .arg("--data-dir")
        .arg(socket.parent().unwrap_or(&socket))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its own process group, so a terminal that hangs up on the client that
    // started it does not take the runner with it. Credentials survive this:
    // the audit session the child inherits is what macOS keys keychain access
    // on, and that outlives the parent.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn()?;

    for _ in 0..100 {
        if daemon::is_running(&socket).await {
            println!("started {}", socket.display());
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    anyhow::bail!("the runner did not start listening on {}", socket.display())
}

async fn stop(socket: PathBuf) -> anyhow::Result<()> {
    let mut client = Client::connect(&socket).await?;
    client.request(Request::DaemonStop).await?;
    println!("stopped");
    Ok(())
}

async fn status(socket: PathBuf) -> anyhow::Result<()> {
    let mut client = Client::connect(&socket).await?;
    let reply = client.request(Request::DaemonStatus).await?;
    print_json(&reply)
}

async fn create(args: CreateArgs) -> anyhow::Result<()> {
    let socket = socket_path(&args.data)?;
    let mut env = BTreeMap::new();
    for entry in &args.env {
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("--env expects KEY=VALUE, got {entry}"))?;
        env.insert(key.to_string(), value.to_string());
    }

    let mut client = Client::connect(&socket).await?;
    let reply = client
        .request(Request::SessionCreate {
            session: args.session,
            spawn: SpawnRequest {
                argv: args.argv,
                cwd: args.cwd.display().to_string(),
                env,
            },
            attach: false,
        })
        .await?;
    print_json(&reply)
}

async fn list(socket: PathBuf) -> anyhow::Result<()> {
    let mut client = Client::connect(&socket).await?;
    let reply = client.request(Request::SessionList).await?;
    print_json(&reply)
}

async fn close(args: SessionArgs) -> anyhow::Result<()> {
    let socket = socket_path(&args.data)?;
    let mut client = Client::connect(&socket).await?;
    client
        .request(Request::SessionClose {
            session: args.session,
        })
        .await?;
    println!("closed");
    Ok(())
}

/// Attach is the shape the backend will use: one connection carrying frames out
/// and frames in at the same time.
async fn attach(args: AttachArgs) -> anyhow::Result<()> {
    let socket = socket_path(&args.data)?;
    let client = Client::connect(&socket).await?;
    // The handshake is awaited before streaming begins, so a refused attach
    // fails the command instead of leaving it waiting on a session it never
    // got.
    let (_info, streaming) = if args.argv.is_empty() {
        client.attach(&args.session).await?
    } else {
        let cwd = match args.cwd {
            Some(cwd) => cwd,
            None => std::env::current_dir()?,
        };
        client
            .create_attached(
                &args.session,
                SpawnRequest {
                    argv: args.argv,
                    cwd: cwd.display().to_string(),
                    env: BTreeMap::new(),
                },
            )
            .await?
    };
    let client::Streaming {
        held,
        mut reader,
        mut frames,
    } = streaming;

    let forward = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = stdin.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(frame) = RawValue::from_string(line) else {
                eprintln!("skipping a line that is not JSON");
                continue;
            };
            if frames.send(frame).await.is_err() {
                return;
            }
        }
    });

    let mut stdout = tokio::io::stdout();
    // What arrived before streaming began comes first, or the front of the
    // conversation would be missing from the bridge.
    for line in held {
        stdout.write_all(line.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            break;
        }
        stdout.write_all(line.as_bytes()).await?;
        stdout.flush().await?;
    }
    forward.abort();
    Ok(())
}

fn print_json<T: serde::Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_line_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn the_spawn_command_is_taken_verbatim_after_a_separator() {
        // Arguments meant for the child must not be interpreted here: a flag
        // the runner happens to share a name with still belongs to the child.
        let cli = Cli::try_parse_from([
            "caffold-claude-runner",
            "session",
            "create",
            "--session",
            "s1",
            "--cwd",
            "/tmp",
            "--",
            "claude",
            "-p",
            "--session",
            "not-ours",
        ])
        .expect("parse");

        let Command::Session(SessionCommand::Create(args)) = cli.command else {
            panic!("wrong command");
        };
        assert_eq!(args.session, "s1");
        assert_eq!(args.argv, ["claude", "-p", "--session", "not-ours"]);
    }

    #[test]
    fn the_socket_lives_in_the_data_directory() {
        let socket = socket_path(&DataDirArgs {
            data_dir: Some(PathBuf::from("/tmp/example-data")),
        })
        .expect("socket path");

        assert_eq!(
            socket,
            PathBuf::from("/tmp/example-data/claude-runner.sock")
        );
    }
}
