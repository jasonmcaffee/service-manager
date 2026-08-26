use anyhow::{Context, bail};
use service_manager_rs::{AppConfig, build_application, initialize_state, run_log_pump};
use std::path::PathBuf;
use tokio::net::TcpListener;
use tracing::{info, warn};

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
    // The addresses are claimed BEFORE any state is opened. A second manager started by accident -
    // a duplicate startup entry, a stray `npm start` - would otherwise adopt live services and run
    // boot startup against the same database on its way to discovering it cannot bind, mutating the
    // box before failing. Binding first makes a duplicate launch fail fast and harmlessly.
    let listeners = bind_every_configured_address(&config).await?;
    let state = initialize_state(config.clone()).await?;
    let app = build_application(state);
    let (shutdown_sender, _) = tokio::sync::watch::channel(false);
    let mut servers = Vec::new();
    for listener in listeners {
        let address = listener.local_addr().context("reading a bound listener address")?;
        info!(%address, passive = config.passive, "Service Manager Rust listener ready");
        let mut shutdown = shutdown_sender.subscribe();
        let app = app.clone();
        servers.push(tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown.changed().await;
                })
                .await
                .with_context(|| format!("serving Service Manager on {address}"))
        }));
    }
    shutdown_signal().await;
    let _ = shutdown_sender.send(true);
    for server in servers {
        server.await.context("waiting for a Service Manager listener to stop")??;
    }
    Ok(())
}

/// Binds every address the configuration asks for, refusing to start when one is already taken.
///
/// An address already in use is always fatal. The manager claims both loopback families precisely so
/// that nothing else can answer `localhost:4000` in its place, so quietly skipping a busy address
/// would reinstate the shadowing this exists to prevent - and that shadowing is invisible, because the
/// manager looks perfectly healthy on the family it did get. An address the host simply cannot offer
/// (IPv6 disabled, say) is only a warning, as long as something else bound.
async fn bind_every_configured_address(config: &AppConfig) -> anyhow::Result<Vec<TcpListener>> {
    let addresses = config.listen_addresses()?;
    let mut listeners = Vec::new();
    for address in &addresses {
        match TcpListener::bind(address).await {
            Ok(listener) => listeners.push(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                bail!("{address} is already in use by another process; stop whatever holds port {} before starting the Service Manager ({error})", config.port);
            }
            Err(error) => warn!(%address, %error, "skipping a listen address this host does not support"),
        }
    }
    if listeners.is_empty() {
        bail!("could not bind any Service Manager listen address ({addresses:?})");
    }
    Ok(listeners)
}

/// Resolves when Ctrl+C or the Windows termination signal asks the manager to stop.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received; managed services remain running for adoption");
}

