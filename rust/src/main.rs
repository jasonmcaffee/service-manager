use anyhow::Context;
use service_manager_rs::{AppConfig, build_application, initialize_state};
use tokio::net::TcpListener;
use tracing::info;

/// Starts the Rust Service Manager and waits for a graceful shutdown signal.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .compact()
        .init();

    let config = AppConfig::from_environment()?;
    let state = initialize_state(config.clone()).await?;
    let app = build_application(state);
    let address = format!("{}:{}", config.bind_address, config.port);
    let listener = TcpListener::bind(&address)
        .await
        .with_context(|| format!("binding Service Manager to {address}"))?;
    info!(address, passive = config.passive, "Service Manager Rust listener ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serving Service Manager")?;
    Ok(())
}

/// Resolves when Ctrl+C or the Windows termination signal asks the manager to stop.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received; managed services remain running for adoption");
}

