use anyhow::{Context, bail};
use std::path::{Path, PathBuf};

/// Runtime configuration resolved from environment variables and stable repository defaults.
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub bind_address: String,
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
            bind_address: std::env::var("SERVICE_MANAGER_BIND").unwrap_or_else(|_| "127.0.0.1".into()),
            port,
            database_path,
            repository_root,
            runtime_root,
            passive: parse_boolean_environment("SM_PASSIVE"),
            skip_autostart: parse_boolean_environment("SM_SKIP_AUTOSTART"),
            reconcile_interval_seconds: environment_u64("SM_RECONCILE_SECONDS", 10),
        })
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
