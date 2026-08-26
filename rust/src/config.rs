use anyhow::{Context, bail};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};

/// Runtime configuration resolved from environment variables and stable repository defaults.
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub bind_override: Option<String>,
    pub port: u16,
    pub database_path: PathBuf,
    pub repository_root: PathBuf,
    pub runtime_root: PathBuf,
    pub passive: bool,
    pub skip_autostart: bool,
    pub reconcile_interval_seconds: u64,
}

impl AppConfig {
    /// Resolves validated production defaults while allowing isolated shadow overrides.
    pub fn from_environment() -> anyhow::Result<Self> {
        let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repository_root = manifest_root.parent().context("Rust crate must live under repository root")?.to_path_buf();
        let database_path = std::env::var_os("SERVICE_MANAGER_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|| repository_root.join("prisma").join("service-manager.db"));
        let runtime_root = std::env::var_os("SERVICE_MANAGER_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("service-manager"));
        // SERVICE_MANAGER_PORT only. A bare PORT is deliberately IGNORED: every managed service's
        // wrapper script sets PORT for the service it is launching, so any process descended from a
        // managed service - which is every agent terminal on this box - inherits somebody else's
        // PORT. Honouring it made the manager try to bind 8092, the Claude terminal daemon's port,
        // when it was started from such a shell. It failed to bind and exited, but had that port
        // been free the manager would have taken a managed service's address.
        let port = std::env::var("SERVICE_MANAGER_PORT").unwrap_or_else(|_| "4000".into()).parse::<u16>()
            .context("SERVICE_MANAGER_PORT must be an integer from 1 through 65535")?;
        if port == 0 { bail!("SERVICE_MANAGER_PORT must be greater than zero"); }
        if let Ok(inherited) = std::env::var("PORT") {
            tracing::debug!(%inherited, "ignoring an inherited PORT; the manager binds SERVICE_MANAGER_PORT or 4000");
        }
        Ok(Self {
            bind_override: std::env::var("SERVICE_MANAGER_BIND").ok().filter(|value| !value.trim().is_empty()),
            port,
            database_path,
            repository_root,
            runtime_root,
            passive: parse_boolean_environment("SM_PASSIVE"),
            skip_autostart: parse_boolean_environment("SM_SKIP_AUTOSTART"),
            reconcile_interval_seconds: environment_u64("SM_RECONCILE_SECONDS", 10),
        })
    }

    /// Lists every socket address the manager must listen on, defaulting to BOTH loopback families.
    ///
    /// `localhost` resolves to `::1` before `127.0.0.1` on Windows, so an IPv4-only listener leaves
    /// the IPv6 loopback unclaimed - and any other process is then free to bind it and answer for the
    /// Service Manager. That is not hypothetical: a stale `next dev` left over from the pre-Rust
    /// startup script bound `[::]:4000`, so every browser and the desktop webview reached the old Node
    /// UI, whose API routes no longer exist, and the page reported "Failed to load services" while the
    /// real manager sat healthy on 127.0.0.1. Claiming both families means the manager always answers
    /// `localhost`. Note that this wins by specificity, not by exclusion: Windows still lets another
    /// process bind the `::` wildcard alongside a specific `::1` bind, but a connection goes to the
    /// most specific matching listener, so the squatter binds and then never receives anything.
    /// Measured on task-1668 with a `next dev`-shaped squatter running: all nine host/path
    /// combinations still came back from the manager.
    /// An explicit SERVICE_MANAGER_BIND is honoured verbatim and is never expanded to a second family.
    pub fn listen_addresses(&self) -> anyhow::Result<Vec<SocketAddr>> {
        let Some(requested) = self.bind_override.as_deref() else {
            return Ok(vec![
                SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), self.port),
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.port),
            ]);
        };
        let address = requested
            .trim()
            .parse::<IpAddr>()
            .with_context(|| format!("SERVICE_MANAGER_BIND must be an IP address, got {requested}"))?;
        Ok(vec![SocketAddr::new(address, self.port)])
    }
}

/// Reads a permissive boolean environment variable without treating absence as an error.
fn parse_boolean_environment(name: &str) -> bool {
    std::env::var(name).map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(false)
}

/// Reads a positive integer environment variable and falls back to a stable default.
fn environment_u64(name: &str, default_value: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).filter(|value| *value > 0).unwrap_or(default_value)
}
