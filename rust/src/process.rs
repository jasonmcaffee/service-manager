use crate::config::AppConfig;
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::logging::{append_service_event, clear_run_log, run_log_path};
use crate::models::ServiceRow;
use crate::system::{ProcessTable, ancestors_of, delete_port_proxy_rules, snapshot_listeners, snapshot_process_table, terminate_windows_pid, terminate_wsl_pid};
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::time::{Duration, sleep};

const PROTECTED_COMMAND_PATTERNS: [&str; 9] = ["terminal-daemon.cjs", "\\claude.exe", "\\claude-skip", "opencode", "service-manager\\node_modules", "\\system32\\svchost.exe", "\\system32\\services.exe", "wslhost.exe", "wslservice.exe"];

/// Whether a tracked service was spawned here or adopted from an operating-system listener.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ProcessKind { Spawned, WindowsAdopted, WslAdopted, NoPortAdopted }

/// Bounded in-memory lifecycle metadata; service output remains file-backed.
#[derive(Clone, Debug)]
pub struct TrackedProcess {
    pub status: String,
    pub pid: Option<u32>,
    pub wrapper_pid: Option<u32>,
    pub kind: ProcessKind,
}

/// Owns exact-PID process lifecycle and adoption without retaining output in memory.
#[derive(Clone)]
pub struct ProcessSupervisor {
    config: AppConfig,
    database: Arc<Database>,
    tracked: Arc<RwLock<HashMap<String, TrackedProcess>>>,
}

impl ProcessSupervisor {
    /// Creates an empty supervisor that will be populated by the initial adoption pass.
    pub fn new(config: AppConfig, database: Arc<Database>) -> Self {
        Self { config, database, tracked: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// Returns the manager's current status and PID view for a service.
    pub fn status(&self, service_id: &str) -> Option<TrackedProcess> {
        self.tracked.read().get(service_id).cloned()
    }

    /// Returns true only when the current process map considers the service running.
    pub fn is_running(&self, service_id: &str) -> bool {
        self.status(service_id).is_some_and(|process| process.status == "running")
    }

    /// Returns every PID currently associated with each service for foreign-owner protection.
    pub fn tracked_pids(&self) -> HashMap<String, Vec<u32>> {
        self.tracked.read().iter().map(|(id, process)| {
            let mut pids = Vec::new();
            if let Some(pid) = process.pid { pids.push(pid); }
            if let Some(pid) = process.wrapper_pid.filter(|pid| !pids.contains(pid)) { pids.push(pid); }
            (id.clone(), pids)
        }).collect()
    }

    /// Adopts a live listener or no-port log signal without spawning or duplicating it.
    pub fn adopt(&self, service_id: &str, pid: Option<u32>, kind: ProcessKind) -> AppResult<()> {
        self.tracked.write().insert(service_id.to_owned(), TrackedProcess { status: "running".into(), pid, wrapper_pid: None, kind });
        self.database.update_runtime(service_id, "running", pid)?;
        Ok(())
    }

    /// Marks a previously tracked service stopped and records why that conclusion was reached.
    pub fn mark_stopped(&self, service: &ServiceRow, reason: &str) -> AppResult<()> {
        let was_running = self.is_running(&service.id);
        self.tracked.write().insert(service.id.clone(), TrackedProcess { status: "stopped".into(), pid: None, wrapper_pid: None, kind: ProcessKind::WindowsAdopted });
        self.database.update_runtime(&service.id, "stopped", None)?;
        if was_running { append_service_event(&self.config.runtime_root, &service.id, &format!("Marked STOPPED by Service Manager: {reason}"))?; }
        Ok(())
    }

    /// Starts a configured command through a hidden, uniquely identifiable wrapper and file-backed log.
    pub async fn start(&self, service: &ServiceRow, environment: &HashMap<String, String>) -> AppResult<TrackedProcess> {
        self.require_active_mode("start services")?;
        self.reap_stale_wrappers(&service.id).await?;
        clear_run_log(&self.config.runtime_root, &service.id)?;
        let script = self.write_startup_scripts(service, environment)?;
        self.database.update_runtime(&service.id, "starting", None)?;
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", script.to_string_lossy().as_ref()]);
        command.current_dir(&self.config.repository_root);
        command.kill_on_drop(false);
        command.env_remove("NoDefaultCurrentDirectoryInExePath");
        #[cfg(windows)] {
            command.creation_flags(0x0800_0000);
        }
        let child = command.spawn().map_err(|error| AppError::internal("spawning service wrapper", error))?;
        let pid = child.id().ok_or_else(|| AppError::internal("spawning service wrapper", "no PID returned"))?;
        let tracked = TrackedProcess { status: "running".into(), pid: Some(pid), wrapper_pid: Some(pid), kind: ProcessKind::Spawned };
        self.tracked.write().insert(service.id.clone(), tracked.clone());
        self.database.update_runtime(&service.id, "running", Some(pid))?;
        self.watch_child_exit(service.clone(), pid, child);
        Ok(tracked)
    }

    /// Stops only the service's exact tracked wrapper/listener and persists deliberate intent first.
    pub async fn stop(&self, service: &ServiceRow) -> AppResult<TrackedProcess> {
        self.require_active_mode("stop services")?;
        self.database.set_desired_status(&service.id, "stopped")?;
        let tracked = self.status(&service.id);
        if let Some(process) = tracked {
            match (process.kind, process.wrapper_pid.or(process.pid)) {
                (ProcessKind::WslAdopted, Some(pid)) => terminate_wsl_pid(pid).await?,
                (ProcessKind::Spawned, Some(pid)) => terminate_windows_pid(pid, true).await?,
                (_, Some(pid)) => self.terminate_adopted_windows(service, pid).await?,
                (_, None) => {}
            }
        }
        sleep(Duration::from_millis(150)).await;
        if let Some(port) = service.port.and_then(|value| u16::try_from(value).ok()) { self.free_exact_port(service, port).await?; }
        self.tracked.write().insert(service.id.clone(), TrackedProcess { status: "stopped".into(), pid: None, wrapper_pid: None, kind: ProcessKind::WindowsAdopted });
        self.database.update_runtime(&service.id, "stopped", None)?;
        append_service_event(&self.config.runtime_root, &service.id, "Process stopped after Service Manager requested it.")?;
        Ok(self.status(&service.id).expect("stopped status was inserted"))
    }

    /// Frees a service's exact registered port while blocking protected or foreign tracked PIDs.
    pub async fn free_port(&self, service: &ServiceRow) -> AppResult<Vec<u32>> {
        let Some(port) = service.port.and_then(|value| u16::try_from(value).ok()) else { return Ok(Vec::new()) };
        self.free_exact_port(service, port).await
    }

    /// Returns the set of PIDs process and GPU guards must never terminate for this owner.
    pub async fn protected_pids(&self, owner: &ServiceRow) -> AppResult<HashSet<u32>> {
        let table = snapshot_process_table().await?;
        Ok(self.build_protected_pids(owner, &table))
    }

    /// Writes environment and command launcher files compatible with arbitrary existing batch content.
    fn write_startup_scripts(&self, service: &ServiceRow, environment: &HashMap<String, String>) -> AppResult<PathBuf> {
        fs::create_dir_all(&self.config.runtime_root).map_err(|error| AppError::internal("creating runtime directory", error))?;
        let inner = self.config.runtime_root.join(format!("service-{}-cmd.bat", service.id));
        let outer = self.config.runtime_root.join(format!("service-{}.bat", service.id));
        let log = run_log_path(&self.config.runtime_root, &service.id);
        if let Some(parent) = log.parent() { fs::create_dir_all(parent).map_err(|error| AppError::internal("creating service log directory", error))?; }
        fs::write(&inner, format!("@echo off\r\n{}\r\n", service.command)).map_err(|error| AppError::internal("writing service command script", error))?;
        let mut lines = vec!["@echo off".to_owned(), "set PYTHONUNBUFFERED=1".to_owned()];
        for (name, value) in environment { lines.push(format!("set \"{name}={}\"", value.replace('"', ""))); }
        lines.push(format!("type nul > \"{}\"", log.display()));
        lines.push(format!("call \"{}\" >> \"{}\" 2>&1", inner.display(), log.display()));
        lines.push("exit /b %errorlevel%".into());
        fs::write(&outer, format!("{}\r\n", lines.join("\r\n"))).map_err(|error| AppError::internal("writing service wrapper script", error))?;
        Ok(outer)
    }

    /// Watches a spawned wrapper without killing it when the manager itself shuts down.
    fn watch_child_exit(&self, service: ServiceRow, pid: u32, mut owned_child: tokio::process::Child) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let status = owned_child.wait().await;
            let current = supervisor.status(&service.id);
            if current.as_ref().and_then(|value| value.wrapper_pid) != Some(pid) { return; }
            let (state, detail) = match status {
                Ok(exit) if exit.success() => ("stopped", format!("Process exited with code {:?}.", exit.code())),
                Ok(exit) => ("error", format!("Process EXITED with code {:?}; Service Manager did not request this exit.", exit.code())),
                Err(error) => ("error", format!("Process wait failed: {error}")),
            };
            supervisor.tracked.write().insert(service.id.clone(), TrackedProcess { status: state.into(), pid: None, wrapper_pid: None, kind: ProcessKind::Spawned });
            let _ = supervisor.database.update_runtime(&service.id, state, None);
            let _ = append_service_event(&supervisor.config.runtime_root, &service.id, &detail);
        });
    }

    /// Kills one adopted listener only when it passes the process-protection set.
    async fn terminate_adopted_windows(&self, owner: &ServiceRow, pid: u32) -> AppResult<()> {
        let table = snapshot_process_table().await?;
        let protected = self.build_protected_pids(owner, &table);
        if protected.contains(&pid) { return Err(AppError::Conflict(format!("Refusing to terminate protected PID {pid}."))); }
        terminate_windows_pid(pid, false).await
    }

    /// Finds and terminates exact listeners on one port without recursive foreign-tree kills.
    async fn free_exact_port(&self, owner: &ServiceRow, port: u16) -> AppResult<Vec<u32>> {
        self.require_active_mode("kill ports")?;
        delete_port_proxy_rules(port).await?;
        let snapshot = snapshot_listeners().await;
        let table = snapshot_process_table().await?;
        let protected = self.build_protected_pids(owner, &table);
        let mut killed = Vec::new();
        for pid in snapshot.windows.as_ref().and_then(|map| map.get(&port)).cloned().unwrap_or_default() {
            if protected.contains(&pid) { return Err(AppError::Conflict(format!("Refusing to terminate protected PID {pid} on port {port}."))); }
            let tree = self.status(&owner.id).and_then(|value| value.wrapper_pid).is_some_and(|wrapper| wrapper == pid || ancestors_of(pid, &table.parent_by_pid).contains(&wrapper));
            terminate_windows_pid(pid, tree).await?;
            killed.push(pid);
        }
        for pid in snapshot.wsl.as_ref().and_then(|map| map.get(&port)).cloned().unwrap_or_default() {
            terminate_wsl_pid(pid).await?;
            killed.push(pid);
        }
        Ok(killed)
    }

    /// Reaps wrappers identified by the unique generated service script path from previous manager runs.
    async fn reap_stale_wrappers(&self, service_id: &str) -> AppResult<()> {
        let table = snapshot_process_table().await?;
        let marker = format!("service-{service_id}.bat").to_ascii_lowercase();
        let self_ancestors = ancestors_of(std::process::id(), &table.parent_by_pid).into_iter().collect::<HashSet<_>>();
        for (pid, command) in &table.command_by_pid {
            if !command.to_ascii_lowercase().contains(&marker) || self_ancestors.contains(pid) { continue; }
            terminate_windows_pid(*pid, true).await?;
        }
        Ok(())
    }

    /// Constructs the never-kill set for one owner from manager, terminal, system, and foreign service PIDs.
    fn build_protected_pids(&self, owner: &ServiceRow, table: &ProcessTable) -> HashSet<u32> {
        build_protected_pid_set(owner, std::process::id(), table, &self.tracked_pids())
    }

    /// Prevents passive shadow instances from mutating real process state.
    fn require_active_mode(&self, action: &str) -> AppResult<()> {
        if self.config.passive { return Err(AppError::Conflict(format!("Passive shadow mode cannot {action}."))); }
        Ok(())
    }
}

/// Builds hard and soft never-kill protections while allowing deliberate owner actions.
fn build_protected_pid_set(owner: &ServiceRow, manager_pid: u32, table: &ProcessTable, tracked: &HashMap<String, Vec<u32>>) -> HashSet<u32> {
    let mut hard = HashSet::from([0, 1, 2, 3, 4]);
    hard.extend(ancestors_of(manager_pid, &table.parent_by_pid));
    let mut protected = hard.clone();
    for (pid, command) in &table.command_by_pid {
        let text = format!("{} {command}", table.name_by_pid.get(pid).cloned().unwrap_or_default()).to_ascii_lowercase();
        if PROTECTED_COMMAND_PATTERNS.iter().any(|pattern| text.contains(pattern)) { protected.extend(ancestors_of(*pid, &table.parent_by_pid)); }
    }
    for (service_id, pids) in tracked {
        if service_id != &owner.id { protected.extend(pids); }
    }
    if let Some(owner_pids) = tracked.get(&owner.id) {
        for pid in owner_pids { if !hard.contains(pid) { protected.remove(pid); } }
    }
    protected
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal owner service for process-guard tests.
    fn owner_service() -> ServiceRow {
        ServiceRow { id: "owner".into(), name: "Fixture".into(), description: None, command: "fixture.exe".into(), port: Some(45000), no_port: false, wsl: false, cuda_device: None, min_free_vram_mb: None, start_on_boot: false, pid: None, status: "running".into(), desired_status: "running".into(), created_at: String::new(), updated_at: String::new() }
    }

    /// Infrastructure patterns, their ancestors, and foreign service PIDs remain protected.
    #[test]
    fn protected_pid_set_covers_infrastructure_and_foreign_services() {
        let table = ProcessTable { parent_by_pid: HashMap::from([(100, 90), (90, 4), (30, 4), (40, 4)]), name_by_pid: HashMap::from([(100, "svchost.exe".into())]), command_by_pid: HashMap::from([(100, "C:\\Windows\\System32\\svchost.exe -k netsvcs".into()), (30, "opencode terminal".into())]) };
        let tracked = HashMap::from([("owner".into(), vec![30]), ("foreign".into(), vec![40])]);
        let protected = build_protected_pid_set(&owner_service(), 500, &table, &tracked);
        assert!(protected.contains(&100));
        assert!(protected.contains(&90));
        assert!(protected.contains(&40));
        assert!(!protected.contains(&30));
    }
}
