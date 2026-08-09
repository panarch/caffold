use std::{net::IpAddr, path::PathBuf, sync::Arc};

use axum::Router;
use tokio::{net::TcpListener, sync::broadcast};
use tracing::info;

mod error;
mod shell;
mod tasks;
mod voice;
mod workspace;

use crate::{fs::RootedFs, server_settings::ServerSettingsStore};

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub worktree_root: Option<PathBuf>,
}

pub async fn serve(config: ServeConfig) -> anyhow::Result<()> {
    let (fs, initial_path, home_path) = match config.root {
        Some(root) => (RootedFs::new(root)?, String::new(), None),
        None => {
            let fs = RootedFs::from_filesystem_root()?;
            let home = RootedFs::home_dir()?;
            let home_path = fs.logical_path_for_absolute(&home)?;
            (fs, home_path.clone(), Some(home_path))
        }
    };
    let data_dir = config.data_dir.unwrap_or(default_data_dir()?);
    let worktree_root = config
        .worktree_root
        .unwrap_or_else(|| data_dir.join("worktrees"));
    let server_settings = Arc::new(ServerSettingsStore::persistent(
        data_dir.join("server.json"),
    )?);
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let root = fs.root().to_path_buf();
    let shell_router = shell::router(fs.clone(), server_settings, initial_path.clone(), home_path);
    let workspace_router = workspace::router(fs.clone(), shutdown.clone());
    let voice_router = voice::router(data_dir.join("models/whisper"));
    let tasks = tasks::TasksApp::persistent(
        fs,
        initial_path.clone(),
        shutdown.clone(),
        data_dir.join("caffold.redb"),
        worktree_root.clone(),
    )?;
    let app = router_with_states(shell_router, workspace_router, tasks.router(), voice_router);
    let listener = TcpListener::bind((config.host, config.port)).await?;
    let addr = listener.local_addr()?;

    info!("serving Caffold at http://{addr}");
    info!("browsing root {}", root.display());
    info!("initial path {initial_path}");
    println!("Caffold is serving http://{addr}");
    println!("Browsing root {}", root.display());
    println!("Data directory {}", data_dir.display());
    println!("Managed worktree directory {}", worktree_root.display());
    println!(
        "Initial path {}",
        if initial_path.is_empty() {
            "/"
        } else {
            &initial_path
        }
    );

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await;
    tasks.shutdown().await;
    result?;

    Ok(())
}

pub fn router(fs: RootedFs) -> anyhow::Result<Router> {
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let shell_router = shell::router(
        fs.clone(),
        Arc::new(ServerSettingsStore::memory()),
        String::new(),
        None,
    );
    let workspace_router = workspace::router(fs.clone(), shutdown.clone());
    let voice_router = voice::router(fs.root().join(".caffold-test/models/whisper"));
    let worktree_root = fs.root().join(".caffold-test/worktrees");
    let tasks = tasks::TasksApp::memory(fs, String::new(), shutdown, worktree_root)?;
    Ok(router_with_states(
        shell_router,
        workspace_router,
        tasks.router(),
        voice_router,
    ))
}

fn router_with_states(
    shell_router: Router,
    workspace_router: Router,
    tasks_router: Router,
    voice_router: Router,
) -> Router {
    shell_router
        .merge(workspace_router)
        .merge(tasks_router)
        .merge(voice_router)
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    Ok(RootedFs::home_dir()?.join(".caffold"))
}

async fn shutdown_signal(shutdown: broadcast::Sender<()>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};

        if let Ok(mut signal) = signal(SignalKind::terminate()) {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    let _ = shutdown.send(());
}

#[cfg(test)]
mod tests;
