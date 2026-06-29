#[tokio::main]
async fn main() -> anyhow::Result<()> {
    codger::cli::run().await
}
