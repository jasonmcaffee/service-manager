use anyhow::Context;
use service_manager_rs::{AppConfig, build_application, initialize_state, run_log_pump};
use std::path::PathBuf;
use tokio::net::TcpListener;
use tracing::info;

/// Runs the service log pump when asked, otherwise starts the manager.
///
/// The pump is a mode of this same binary rather than a separate executable so a managed service's
/// wrapper script has something to pipe through that is guaranteed to exist next to the manager.
/// It must run before any async runtime or tracing subscriber is installed: it owns stdin and the
/// log file for the whole life of the service and does nothing else.
fn main() -> anyhow::Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.get(1).map(String::as_str) == Some("--log-pump") {
        let log_file = PathBuf::from(arguments.get(2).context("--log-pump needs a log file path")?);
        let max_bytes = arguments.get(3).and_then(|value| value.parse().ok()).unwrap_or(service_manager_rs::MAX_LOG_BYTES);
        let keep_bytes = arguments.get(4).and_then(|value| value.parse().ok()).unwrap_or(service_manager_rs::KEEP_LOG_BYTES);
        // A pump failure must not take the service down with it; the service keeps running and
        // simply stops producing captured output, which the reconciler already reports.
        if let Err(error) = run_log_pump(&log_file, max_bytes, keep_bytes) { eprintln!("service-manager log pump stopped: {error}"); }
        return Ok(());
    }
    serve()
}

/// Starts the Rust Service Manager and waits for a graceful shutdown signal.
#[tokio::main]
async fn serve() -> anyhow::Result<()> {
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

