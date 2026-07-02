#[tokio::main]
async fn main() -> anyhow::Result<()> {
    caffold::cli::run().await
}
