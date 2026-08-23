use crate::config::AppConfig;
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::gpu::{assert_vram_available, cuda_device_conflict, command_cuda_device, effective_cuda_device, parse_cuda_devices, reap_owned_gpu_orphans};
use crate::logging::{append_service_event, cap_all_run_logs, read_run_log, read_service_events, run_log_path};
use crate::metrics::Metrics;
use crate::models::{ConfigSnapshot, ProfileOverrideMutation, ProfileView, ServiceMutation, ServiceRow, ServiceView};
use crate::process::{ProcessKind, ProcessSupervisor};
use crate::system::{ListenerSnapshot, ensure_wsl_port_proxy, snapshot_listeners, snapshot_process_table};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant, SystemTime};
use tokio::time::sleep;

const NO_PORT_FRESHNESS: Duration = Duration::from_secs(30 * 60);
const AUTO_RESTART_DELAYS: [Duration; 6] = [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30), Duration::from_secs(60), Duration::from_secs(120), Duration::from_secs(300)];
const BOOT_RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(30), Duration::from_secs(90), Duration::from_secs(180)];

#[derive(Clone, Debug)]
struct RestartState {
    attempts: usize,
    next_attempt: Instant,
    healthy_since: Option<Instant>,
}

/// Shared application state with explicit domain and infrastructure boundaries.
#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub database: Arc<Database>,
    pub processes: ProcessSupervisor,
    pub metrics: Arc<Metrics>,
    boot_started: Arc<AtomicBool>,
    restart_state: Arc<Mutex<HashMap<String, RestartState>>>,
}

/// Opens persistence, adopts live services, performs guarded boot startup, and starts reconciliation.
pub async fn initialize_state(config: AppConfig) -> anyhow::Result<AppState> {
    let database = Arc::new(Database::open(&config.database_path)?);
    let processes = ProcessSupervisor::new(config.clone(), database.clone());
    let state = AppState { config, database, processes, metrics: Arc::new(Metrics::new()), boot_started: Arc::new(AtomicBool::new(false)), restart_state: Arc::new(Mutex::new(HashMap::new())) };
    state.reconcile_once().await.map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if !state.config.passive && !state.config.skip_autostart {
        state.run_auto_start().await.map_err(|error| anyhow::anyhow!(error.to_string()))?;
        state.spawn_boot_retry_sweeps();
    }
    state.metrics.set_ready(true);
    state.spawn_reconcile_loop();
    Ok(state)
}

impl AppState {
    /// Returns all services hydrated with active-profile fields and current process state.
    pub fn list_service_views(&self) -> AppResult<Vec<ServiceView>> {
        let services = self.database.list_services()?;
        let override_map = self.active_override_map()?;
        Ok(services.into_iter().map(|service| {
            let override_entry = override_map.get(&service.id);
            self.hydrate_service(service, override_entry, false)
        }).collect())
    }

    /// Returns one hydrated service and its bounded output lines.
    pub fn get_service_view(&self, service_id: &str) -> AppResult<Option<ServiceView>> {
        let Some(service) = self.database.get_service(service_id)? else { return Ok(None) };
        let override_entry = self.database.active_override(service_id)?;
        Ok(Some(self.hydrate_service(service, override_entry.as_ref(), true)))
    }

    /// Creates a validated service and returns the same hydrated shape as subsequent reads.
    pub fn create_service(&self, mutation: &ServiceMutation, reason: &str, author: &str) -> AppResult<ServiceView> {
        validate_reason(reason, "create service")?;
        validate_port(mutation.port.flatten())?;
        self.assert_unique_port(mutation.port.flatten(), None)?;
        validate_cuda_registration(mutation.cuda_device.as_ref().and_then(|value| value.as_deref()), mutation.command.as_deref().unwrap_or_default())?;
        let row = self.database.create_service(mutation, reason, author)?;
        let override_entry = self.database.active_override(&row.id)?;
        Ok(self.hydrate_service(row, override_entry.as_ref(), false))
    }

    /// Applies a validated partial update and preserves runtime state.
    pub fn update_service(&self, service_id: &str, mutation: &ServiceMutation, reason: &str, author: &str) -> AppResult<ServiceView> {
        validate_reason(reason, "update service")?;
        let current = self.database.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        validate_port(mutation.port.flatten())?;
        self.assert_unique_port(mutation.port.flatten(), Some(service_id))?;
        let command = mutation.command.as_deref().unwrap_or(&current.command);
        let existing_registered = self.database.active_override(service_id)?.and_then(|entry| entry.cuda_device);
        let registered = mutation.cuda_device.clone().unwrap_or(existing_registered);
        validate_cuda_registration(registered.as_deref(), command)?;
        let row = self.database.update_service(service_id, mutation, reason, author, "update", None)?;
        let override_entry = self.database.active_override(service_id)?;
        Ok(self.hydrate_service(row, override_entry.as_ref(), false))
    }

    /// Deletes a service after its exact process is stopped and its immutable revision is recorded.
    pub async fn delete_service(&self, service_id: &str, reason: &str, author: &str) -> AppResult<()> {
        validate_reason(reason, "delete service")?;
        let service = self.database.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        if self.processes.is_running(service_id) { self.processes.stop(&service).await?; }
        self.database.delete_service(service_id, reason, author)
    }

    /// Restores one revision through normal update validation and records a forward revert revision.
    pub fn revert_service(&self, service_id: &str, revision_id: &str, reason: &str, author: &str) -> AppResult<serde_json::Value> {
        validate_reason(reason, "revert service")?;
        let revision = self.database.get_revision(service_id, revision_id)?.ok_or_else(|| AppError::NotFound("Revision not found for this service".into()))?;
        let snapshot_value = revision.snapshot.ok_or_else(|| AppError::Conflict("This revision has no configuration to restore (the service was deleted at that point).".into()))?;
        let snapshot: ConfigSnapshot = serde_json::from_value(snapshot_value).map_err(|error| AppError::internal("decoding revision snapshot for revert", error))?;
        let active = self.database.active_profile()?.ok_or_else(|| AppError::Conflict("No active run profile".into()))?;
        let cross_profile = snapshot.profile_id.as_deref().is_some_and(|profile_id| profile_id != active.id);
        let mutation = mutation_from_snapshot(&snapshot);
        let row = self.database.update_service(service_id, &mutation, reason, author, "revert", Some(revision_id))?;
        let override_entry = self.database.active_override(service_id)?;
        let service = self.hydrate_service(row, override_entry.as_ref(), false);
        let warning = cross_profile.then(|| format!("Profile-scoped values came from profile \"{}\" and were applied to active profile \"{}\".", snapshot.profile_name.unwrap_or_default(), active.name));
        Ok(serde_json::json!({"service":service,"revertedFrom":revision_id,"crossProfile":cross_profile,"warning":warning}))
    }

    /// Starts a service after exact-port, owned-orphan, and VRAM admission checks.
    pub async fn start_service(&self, service_id: &str) -> AppResult<serde_json::Value> {
        self.require_active_mode("start services")?;
        let service = self.database.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        let registered = self.database.active_override(service_id)?.and_then(|entry| entry.cuda_device);
        if !self.processes.is_running(service_id) {
            self.reap_gpu_orphans(&service, registered.as_deref()).await?;
            let occupants = self.gpu_occupants(service_id)?;
            assert_vram_available(&service, registered.as_deref(), &occupants).await.map_err(|error| {
                let _ = append_service_event(&self.config.runtime_root, service_id, &format!("START REFUSED. {error}"));
                error
            })?;
        }
        self.processes.free_port(&service).await?;
        self.database.set_desired_status(service_id, "running")?;
        let environment = self.service_environment(&service, registered.as_deref());
        let process = self.processes.start(&service, &environment).await?;
        if service.wsl {
            if let Some(port) = service.port.and_then(|value| u16::try_from(value).ok()) { ensure_wsl_port_proxy(port).await?; }
        }
        self.metrics.note_start();
        Ok(serde_json::json!({"id":service_id,"status":process.status,"pid":process.pid}))
    }

    /// Deliberately stops a service and performs a scoped GPU orphan sweep.
    pub async fn stop_service(&self, service_id: &str) -> AppResult<serde_json::Value> {
        self.require_active_mode("stop services")?;
        let service = self.database.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        let process = self.processes.stop(&service).await?;
        let registered = self.database.active_override(service_id)?.and_then(|entry| entry.cuda_device);
        let notes = self.reap_gpu_orphans(&service, registered.as_deref()).await?;
        self.metrics.note_stop();
        Ok(serde_json::json!({"id":service_id,"status":process.status,"pid":process.pid,"vramNotes":notes}))
    }

    /// Restarts a service through the same guarded stop and start paths.
    pub async fn restart_service(&self, service_id: &str) -> AppResult<serde_json::Value> {
        let _ = self.stop_service(service_id).await?;
        sleep(Duration::from_millis(500)).await;
        let result = self.start_service(service_id).await?;
        self.metrics.note_restart();
        Ok(result)
    }

    /// Starts each active-profile boot service once and skips adopted/running entries.
    pub async fn run_auto_start(&self) -> AppResult<serde_json::Value> {
        self.require_active_mode("run startup services")?;
        if self.boot_started.swap(true, Ordering::SeqCst) { return Ok(serde_json::json!({"alreadyStarted":true,"results":[]})); }
        let Some(profile) = self.database.active_profile()? else { return Ok(serde_json::json!({"alreadyStarted":false,"results":[]})) };
        let mut results = Vec::new();
        for entry in profile.services.into_iter().filter(|entry| entry.start_on_boot) {
            if self.processes.is_running(&entry.service_id) {
                results.push(serde_json::json!({"id":entry.service_id,"name":entry.service.name,"status":"already_running"}));
                continue;
            }
            self.database.set_desired_status(&entry.service_id, "running")?;
            match self.start_service(&entry.service_id).await {
                Ok(_) => results.push(serde_json::json!({"id":entry.service_id,"name":entry.service.name,"status":"started"})),
                Err(error) => results.push(serde_json::json!({"id":entry.service_id,"name":entry.service.name,"status":"error","error":error.to_string()})),
            }
            sleep(Duration::from_millis(250)).await;
        }
        Ok(serde_json::json!({"alreadyStarted":false,"results":results}))
    }

    /// Schedules bounded boot-recovery sweeps without holding up readiness or process shutdown.
    fn spawn_boot_retry_sweeps(&self) {
        for (index, delay) in BOOT_RETRY_DELAYS.into_iter().enumerate() {
            let state = self.clone();
            tokio::spawn(async move {
                sleep(delay).await;
                if let Err(error) = state.retry_failed_boot_services(index + 1).await { tracing::error!(attempt = index + 1, %error, "boot retry sweep failed"); }
            });
        }
    }

    /// Re-attempts only boot-managed services that remain desired-running and unadopted.
    async fn retry_failed_boot_services(&self, attempt: usize) -> AppResult<()> {
        let Some(profile) = self.database.active_profile()? else { return Ok(()) };
        let services = self.database.list_services()?;
        let running = services.iter().filter(|service| self.processes.is_running(&service.id)).map(|service| service.id.clone()).collect::<HashSet<_>>();
        let candidates = boot_retry_candidates(&services, &profile, &running);
        for service_id in candidates {
            let _ = append_service_event(&self.config.runtime_root, &service_id, &format!("Boot retry attempt {attempt}."));
            if let Err(error) = self.start_service(&service_id).await { tracing::warn!(attempt, %service_id, %error, "boot retry start failed"); }
            sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }

    /// Switches active profiles, applying stops before starts while protecting terminal daemons.
    pub async fn switch_profile(&self, profile_id: &str) -> AppResult<serde_json::Value> {
        self.require_active_mode("switch profiles")?;
        let previous = self.database.active_profile()?.ok_or_else(|| AppError::Conflict("No active profile".into()))?;
        let next = self.database.get_profile(profile_id)?.ok_or_else(|| AppError::NotFound(format!("Profile not found: {profile_id}")))?;
        let actions = self.profile_actions(&previous, &next)?;
        let profile = self.database.set_active_profile(profile_id)?;
        let mut results = Vec::new();
        for (service_id, action) in actions.into_iter().filter(|(_, action)| action == "stop") { results.push(self.apply_profile_action(&service_id, &action, &profile.name).await); }
        for (service_id, action) in self.profile_actions(&previous, &next)?.into_iter().filter(|(_, action)| action != "stop") { results.push(self.apply_profile_action(&service_id, &action, &profile.name).await); }
        Ok(serde_json::json!({"profile":profile,"startedServices":results}))
    }

    /// Updates a profile override after reason and command-pin validation.
    pub fn update_profile_override(&self, profile_id: &str, service_id: &str, mutation: &ProfileOverrideMutation, reason: &str, author: &str) -> AppResult<serde_json::Value> {
        validate_reason(reason, "change profile settings for service")?;
        let service = self.database.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        validate_cuda_registration(mutation.cuda_device.as_ref().and_then(|value| value.as_deref()), &service.command)?;
        let override_entry = self.database.update_profile_override(profile_id, service_id, mutation.cuda_device.clone(), mutation.start_on_boot, mutation.auto_restart, reason, author)?;
        Ok(serde_json::to_value(override_entry).map_err(|error| AppError::internal("serializing profile override", error))?)
    }

    /// Performs one OS-to-database reconcile pass with exact port and PID claims.
    pub async fn reconcile_once(&self) -> AppResult<()> {
        let snapshot = snapshot_listeners().await;
        let mut services = self.database.list_services()?;
        let active = self.database.active_profile()?;
        let boot_ids = active.as_ref().map(|profile| profile.services.iter().filter(|entry| entry.start_on_boot).map(|entry| entry.service_id.clone()).collect::<HashSet<_>>()).unwrap_or_default();
        services.sort_by_key(|service| !boot_ids.contains(&service.id));
        let mut claimed_ports = HashSet::new();
        let mut claimed_pids = HashSet::new();
        for service in &services { self.reconcile_service(service, &snapshot, &mut claimed_ports, &mut claimed_pids)?; }
        if !self.config.passive { self.supervise_auto_restart(&services, active.as_ref()).await; }
        cap_all_run_logs(&self.config.runtime_root)?;
        self.metrics.note_reconcile();
        Ok(())
    }

    /// Reads bounded run output and durable event history for the output endpoint.
    pub fn service_output(&self, service_id: &str) -> AppResult<serde_json::Value> {
        let output = read_run_log(&self.config.runtime_root, service_id, 1000)?;
        let events = read_service_events(&self.config.runtime_root, service_id, 12)?;
        let process = self.processes.status(service_id);
        Ok(serde_json::json!({"output":output,"events":events,"status":process.as_ref().map(|value| value.status.as_str()).unwrap_or("stopped"),"pid":process.and_then(|value| value.pid)}))
    }

    /// Returns low-cardinality Prometheus metrics for the native manager.
    pub fn rendered_metrics(&self) -> AppResult<String> {
        let services = self.database.list_services()?;
        let running = services.iter().filter(|service| self.processes.is_running(&service.id)).count();
        Ok(self.metrics.render(services.len(), running))
    }

    /// Hydrates effective profile and process fields for one persistent service row.
    fn hydrate_service(&self, service: ServiceRow, override_entry: Option<&crate::models::ProfileServiceView>, include_output: bool) -> ServiceView {
        let registered = override_entry.and_then(|entry| entry.cuda_device.clone());
        let tracked = self.processes.status(&service.id);
        let output = include_output.then(|| read_run_log(&self.config.runtime_root, &service.id, 1000).unwrap_or_default());
        ServiceView { id: service.id, name: service.name, description: service.description, command: service.command.clone(), port: service.port, no_port: service.no_port, wsl: service.wsl, cuda_device: effective_cuda_device(registered.as_deref(), &service.command), registered_cuda_device: registered.clone(), cuda_device_source: if command_cuda_device(&service.command).is_some() { "command".into() } else { "profile".into() }, cuda_device_conflict: cuda_device_conflict(registered.as_deref(), &service.command), min_free_vram_mb: service.min_free_vram_mb, start_on_boot: override_entry.map(|entry| entry.start_on_boot).unwrap_or(false), auto_restart: override_entry.map(|entry| entry.auto_restart).unwrap_or(false), pid: tracked.as_ref().and_then(|value| value.pid).map(i64::from).or(service.pid), status: tracked.map(|value| value.status).unwrap_or(service.status), desired_status: service.desired_status, created_at: service.created_at, updated_at: service.updated_at, output }
    }

    /// Reconciles one service against a shared listener snapshot and claim set.
    fn reconcile_service(&self, service: &ServiceRow, snapshot: &ListenerSnapshot, claimed_ports: &mut HashSet<u16>, claimed_pids: &mut HashSet<(ProcessKind, u32)>) -> AppResult<()> {
        let Some(port) = service.port.and_then(|value| u16::try_from(value).ok()) else { return self.reconcile_no_port(service) };
        if self.processes.status(&service.id).is_some_and(|process| process.kind == ProcessKind::Spawned && process.status == "running") { claimed_ports.insert(port); return Ok(()); }
        if claimed_ports.contains(&port) { return self.processes.mark_stopped(service, "another service claimed its port first") }
        let candidate = listener_candidate(service, port, snapshot);
        if let Some((kind, pid)) = candidate {
            if claimed_pids.contains(&(kind.clone(), pid)) { return self.processes.mark_stopped(service, "another service claimed its process first") }
            claimed_ports.insert(port);
            claimed_pids.insert((kind.clone(), pid));
            if self.processes.status(&service.id).is_none_or(|process| process.pid != Some(pid) || process.status != "running") { self.processes.adopt(&service.id, Some(pid), kind)?; }
        } else if snapshot_available(service, snapshot) && (service.status == "running" || self.processes.is_running(&service.id)) {
            self.processes.mark_stopped(service, "nothing is listening on its port any more")?;
        }
        Ok(())
    }

    /// Reconciles a no-port service by the existing 30-minute run-log freshness rule.
    fn reconcile_no_port(&self, service: &ServiceRow) -> AppResult<()> {
        let log = run_log_path(&self.config.runtime_root, &service.id);
        let fresh = log.metadata().ok().and_then(|metadata| metadata.modified().ok()).and_then(|modified| SystemTime::now().duration_since(modified).ok()).is_some_and(|age| age <= NO_PORT_FRESHNESS);
        if fresh && !self.processes.is_running(&service.id) { self.processes.adopt(&service.id, None, ProcessKind::NoPortAdopted)?; }
        if !fresh && (service.status == "running" || self.processes.is_running(&service.id)) { self.processes.mark_stopped(service, "its log file stopped being written to")?; }
        Ok(())
    }

    /// Starts a background reconcile loop whose ticks never overlap.
    fn spawn_reconcile_loop(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(state.config.reconcile_interval_seconds));
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = state.reconcile_once().await { state.metrics.note_reconcile_error(); tracing::error!(%error, "reconcile tick failed"); }
            }
        });
    }

    /// Returns active-profile overrides keyed by service ID without per-service queries.
    fn active_override_map(&self) -> AppResult<HashMap<String, crate::models::ProfileServiceView>> {
        Ok(self.database.active_profile()?.map(|profile| profile.services.into_iter().map(|entry| (entry.service_id.clone(), entry)).collect()).unwrap_or_default())
    }

    /// Prevents passive shadow instances from changing real process or desired-state intent.
    fn require_active_mode(&self, action: &str) -> AppResult<()> {
        if self.config.passive { return Err(AppError::Conflict(format!("Passive shadow mode cannot {action}."))); }
        Ok(())
    }

    /// Ensures an explicit port is valid and unique among other services.
    fn assert_unique_port(&self, port: Option<i64>, exclude_id: Option<&str>) -> AppResult<()> {
        let Some(port) = port else { return Ok(()) };
        let conflicts = self.database.services_by_port(port)?.into_iter().filter(|(id, _)| Some(id.as_str()) != exclude_id).map(|(_, name)| name).collect::<Vec<_>>();
        if conflicts.is_empty() { return Ok(()) }
        Err(AppError::Conflict(format!("Port {port} is already used by: {}. Two services on the same port will cause adoption conflicts.", conflicts.join(", "))))
    }

    /// Builds PORT and CUDA_DEVICE environment values for a configured service.
    fn service_environment(&self, service: &ServiceRow, registered: Option<&str>) -> HashMap<String, String> {
        let mut environment = HashMap::new();
        if let Some(port) = service.port { environment.insert("PORT".into(), port.to_string()); }
        if let Some(cuda) = registered { environment.insert("CUDA_DEVICE".into(), cuda.into()); }
        environment
    }

    /// Maps currently running registered services to their effective GPU devices.
    fn gpu_occupants(&self, exclude_service_id: &str) -> AppResult<HashMap<u32, Vec<String>>> {
        let override_map = self.active_override_map()?;
        let mut occupants = HashMap::<u32, Vec<String>>::new();
        for service in self.database.list_services()? {
            if service.id == exclude_service_id || !self.processes.is_running(&service.id) { continue; }
            let registered = override_map.get(&service.id).and_then(|entry| entry.cuda_device.as_deref());
            for device in effective_cuda_device(registered, &service.command).map(|value| parse_cuda_devices(&value)).unwrap_or_default() { occupants.entry(device).or_default().push(service.name.clone()); }
        }
        Ok(occupants)
    }

    /// Performs the scoped GPU orphan sweep and writes each decision to durable service events.
    async fn reap_gpu_orphans(&self, service: &ServiceRow, registered: Option<&str>) -> AppResult<Vec<String>> {
        let table = snapshot_process_table().await?;
        let protected = self.processes.protected_pids(service).await?;
        let notes = reap_owned_gpu_orphans(service, registered, &self.database.list_services()?, &table, &protected).await?;
        for note in &notes { append_service_event(&self.config.runtime_root, &service.id, note)?; }
        Ok(notes)
    }

    /// Computes start, stop, restart, or noop actions between two profile configurations.
    fn profile_actions(&self, previous: &ProfileView, next: &ProfileView) -> AppResult<Vec<(String, String)>> {
        let services = self.database.list_services()?;
        let previous_map = previous.services.iter().map(|entry| (entry.service_id.as_str(), entry)).collect::<HashMap<_, _>>();
        let next_map = next.services.iter().map(|entry| (entry.service_id.as_str(), entry)).collect::<HashMap<_, _>>();
        Ok(services.into_iter().filter_map(|service| {
            if service.name.to_ascii_lowercase().contains("terminal daemon") { return None; }
            let prior = previous_map.get(service.id.as_str());
            let after = next_map.get(service.id.as_str());
            let running = self.processes.is_running(&service.id);
            let changed = prior.and_then(|entry| entry.cuda_device.as_ref()) != after.and_then(|entry| entry.cuda_device.as_ref());
            let prior_managed = prior.is_some_and(|entry| entry.start_on_boot);
            let next_managed = after.is_some_and(|entry| entry.start_on_boot);
            let action = if running && prior_managed && !next_managed { "stop" } else if running && changed && next_managed { "restart" } else if !running && next_managed { "start" } else { "noop" };
            (action != "noop").then(|| (service.id, action.into()))
        }).collect())
    }

    /// Applies one profile action and returns an error-bearing result without aborting other services.
    async fn apply_profile_action(&self, service_id: &str, action: &str, profile_name: &str) -> serde_json::Value {
        let service_name = self.database.get_service(service_id).ok().flatten().map(|service| service.name).unwrap_or_else(|| service_id.into());
        let _ = append_service_event(&self.config.runtime_root, service_id, &format!("Profile switch: performing {action} (switching to profile \"{profile_name}\")."));
        let result = match action { "stop" => self.stop_service(service_id).await, "start" => self.start_service(service_id).await, "restart" => self.restart_service(service_id).await, _ => Ok(serde_json::json!({})) };
        match result { Ok(_) => serde_json::json!({"id":service_id,"name":service_name,"status":format!("{action}ed")}), Err(error) => serde_json::json!({"id":service_id,"name":service_name,"status":"error","error":error.to_string()}) }
    }

    /// Supervises opted-in services with bounded backoff after reconciliation settles their state.
    async fn supervise_auto_restart(&self, services: &[ServiceRow], active: Option<&ProfileView>) {
        let auto_restart = active.map(|profile| profile.services.iter().filter(|entry| entry.auto_restart).map(|entry| entry.service_id.as_str()).collect::<HashSet<_>>()).unwrap_or_default();
        for service in services {
            if self.processes.is_running(&service.id) {
                let mut states = self.restart_state.lock();
                let state = states.entry(service.id.clone()).or_insert(RestartState { attempts: 0, next_attempt: Instant::now(), healthy_since: Some(Instant::now()) });
                if state.healthy_since.is_none() { state.healthy_since = Some(Instant::now()); }
                if state.healthy_since.is_some_and(|since| since.elapsed() >= Duration::from_secs(120)) { state.attempts = 0; state.next_attempt = Instant::now() + AUTO_RESTART_DELAYS[0]; }
                continue;
            }
            if !auto_restart.contains(service.id.as_str()) || service.desired_status != "running" { self.restart_state.lock().remove(&service.id); continue; }
            let due = { let mut states = self.restart_state.lock(); let state = states.entry(service.id.clone()).or_insert(RestartState { attempts: 0, next_attempt: Instant::now() + AUTO_RESTART_DELAYS[0], healthy_since: None }); if state.healthy_since.take().is_some() { state.next_attempt = Instant::now() + AUTO_RESTART_DELAYS[state.attempts.min(AUTO_RESTART_DELAYS.len() - 1)]; } Instant::now() >= state.next_attempt };
            if !due { continue; }
            let _ = append_service_event(&self.config.runtime_root, &service.id, "Auto-restart attempt after unexpected stop.");
            let result = self.start_service(&service.id).await;
            let mut states = self.restart_state.lock();
            let state = states.entry(service.id.clone()).or_insert(RestartState { attempts: 0, next_attempt: Instant::now(), healthy_since: None });
            if result.is_ok() { state.healthy_since = Some(Instant::now()); } else { state.attempts += 1; state.next_attempt = Instant::now() + AUTO_RESTART_DELAYS[state.attempts.min(AUTO_RESTART_DELAYS.len() - 1)]; }
        }
    }
}

/// Selects boot retry candidates from active-profile intent and the latest runtime state.
fn boot_retry_candidates(services: &[ServiceRow], profile: &ProfileView, running: &HashSet<String>) -> Vec<String> {
    let boot_ids = profile.services.iter().filter(|entry| entry.start_on_boot).map(|entry| entry.service_id.as_str()).collect::<HashSet<_>>();
    services.iter().filter(|service| boot_ids.contains(service.id.as_str()) && service.desired_status == "running" && !running.contains(&service.id)).map(|service| service.id.clone()).collect()
}

/// Chooses the authoritative listener for a service while ignoring WSL's Windows proxy PID.
fn listener_candidate(service: &ServiceRow, port: u16, snapshot: &ListenerSnapshot) -> Option<(ProcessKind, u32)> {
    if service.wsl { return snapshot.wsl.as_ref()?.get(&port)?.first().copied().map(|pid| (ProcessKind::WslAdopted, pid)); }
    snapshot.windows.as_ref().and_then(|map| map.get(&port)).and_then(|pids| pids.first()).copied().map(|pid| (ProcessKind::WindowsAdopted, pid)).or_else(|| snapshot.wsl.as_ref().and_then(|map| map.get(&port)).and_then(|pids| pids.first()).copied().map(|pid| (ProcessKind::WslAdopted, pid)))
}

/// Returns whether the relevant OS listener snapshot succeeded for a service.
fn snapshot_available(service: &ServiceRow, snapshot: &ListenerSnapshot) -> bool {
    if service.wsl { snapshot.wsl.is_some() } else { snapshot.windows.is_some() || snapshot.wsl.is_some() }
}

/// Requires a specific, multi-word reason of at least ten characters.
pub fn validate_reason(reason: &str, action: &str) -> AppResult<()> {
    let trimmed = reason.trim();
    if trimmed.len() < 10 || trimmed.split_whitespace().count() < 2 { return Err(AppError::BadRequest(format!("A reason of at least 10 characters and more than one word is required to {action}."))); }
    Ok(())
}

/// Validates an optional TCP port.
fn validate_port(port: Option<i64>) -> AppResult<()> {
    if port.is_some_and(|port| !(1..=65535).contains(&port)) { return Err(AppError::BadRequest("Port must be an integer between 1 and 65535".into())); }
    Ok(())
}

/// Rejects a registration that contradicts a hard-coded command GPU pin.
fn validate_cuda_registration(registered: Option<&str>, command: &str) -> AppResult<()> {
    let Some(registered) = registered.map(str::trim).filter(|value| !value.is_empty()) else { return Ok(()) };
    if parse_cuda_devices(registered).is_empty() { return Err(AppError::BadRequest(format!("cudaDevice must be a GPU index or comma-separated mask, got \"{registered}\""))); }
    if let Some(command_pin) = command_cuda_device(command) {
        if parse_cuda_devices(registered) != parse_cuda_devices(&command_pin) { return Err(AppError::Conflict(format!("Cannot set cudaDevice to \"{registered}\": the start command hard-codes GPU \"{command_pin}\"."))); }
    }
    Ok(())
}

/// Converts a revision snapshot into the normal partial-update structure.
fn mutation_from_snapshot(snapshot: &ConfigSnapshot) -> ServiceMutation {
    ServiceMutation { name: Some(snapshot.name.clone()), description: Some(snapshot.description.clone()), command: Some(snapshot.command.clone()), port: Some(snapshot.port), no_port: Some(snapshot.no_port), wsl: Some(snapshot.wsl), cuda_device: Some(snapshot.cuda_device.clone()), min_free_vram_mb: Some(snapshot.min_free_vram_mb), start_on_boot: Some(snapshot.start_on_boot), auto_restart: Some(snapshot.auto_restart), reason: None, author: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProfileServiceSummary, ProfileServiceView};

    /// Builds a minimal service record for pure domain-selection tests.
    fn fixture_service(id: &str, desired_status: &str, wsl: bool) -> ServiceRow {
        ServiceRow { id: id.into(), name: id.into(), description: None, command: "fixture.exe".into(), port: Some(45000), no_port: false, wsl, cuda_device: None, min_free_vram_mb: None, start_on_boot: false, pid: None, status: "stopped".into(), desired_status: desired_status.into(), created_at: "2026-01-01T00:00:00.000Z".into(), updated_at: "2026-01-01T00:00:00.000Z".into() }
    }

    /// Builds one active profile whose specified services are boot-managed.
    fn fixture_profile(service_ids: &[&str]) -> ProfileView {
        let services = service_ids.iter().enumerate().map(|(index, id)| ProfileServiceView { id: format!("override-{index}"), profile_id: "balanced".into(), service_id: (*id).into(), cuda_device: None, start_on_boot: true, auto_restart: false, service: ProfileServiceSummary { name: (*id).into(), port: Some(45000 + index as i64) } }).collect();
        ProfileView { id: "balanced".into(), name: "Balanced".into(), is_active: true, created_at: "2026-01-01T00:00:00.000Z".into(), updated_at: "2026-01-01T00:00:00.000Z".into(), services }
    }

    /// Reasons must carry enough incident context to remain useful later.
    #[test]
    fn reason_validation_rejects_short_or_single_word_text() {
        assert!(validate_reason("fix", "update service").is_err());
        assert!(validate_reason("longsingleword", "update service").is_err());
        assert!(validate_reason("Move service to isolated port", "update service").is_ok());
    }

    /// Port validation enforces the full TCP range.
    #[test]
    fn port_validation_enforces_range() {
        assert!(validate_port(Some(0)).is_err());
        assert!(validate_port(Some(65536)).is_err());
        assert!(validate_port(Some(4000)).is_ok());
    }

    /// Boot retries exclude deliberate stops, already-running entries, and non-boot services.
    #[test]
    fn boot_retry_candidates_respect_intent() {
        let services = vec![fixture_service("retry", "running", false), fixture_service("stopped", "stopped", false), fixture_service("up", "running", false), fixture_service("unmanaged", "running", false)];
        let profile = fixture_profile(&["retry", "stopped", "up"]);
        let running = HashSet::from(["up".to_owned()]);
        assert_eq!(boot_retry_candidates(&services, &profile, &running), vec!["retry"]);
    }

    /// Windows services prefer a Windows listener and fall back to a real WSL listener.
    #[test]
    fn listener_selection_prefers_windows_for_windows_services() {
        let snapshot = ListenerSnapshot { windows: Some(HashMap::from([(45000, vec![10])])), wsl: Some(HashMap::from([(45000, vec![20])])) };
        assert_eq!(listener_candidate(&fixture_service("windows", "running", false), 45000, &snapshot), Some((ProcessKind::WindowsAdopted, 10)));
    }

    /// WSL services never adopt the Windows proxy PID for their forwarded port.
    #[test]
    fn listener_selection_uses_wsl_pid_for_wsl_services() {
        let snapshot = ListenerSnapshot { windows: Some(HashMap::from([(45000, vec![10])])), wsl: Some(HashMap::from([(45000, vec![20])])) };
        assert_eq!(listener_candidate(&fixture_service("wsl", "running", true), 45000, &snapshot), Some((ProcessKind::WslAdopted, 20)));
    }

    /// A failed relevant snapshot remains unknown instead of proving a service stopped.
    #[test]
    fn snapshot_availability_is_service_specific() {
        let windows_only = ListenerSnapshot { windows: Some(HashMap::new()), wsl: None };
        assert!(snapshot_available(&fixture_service("windows", "running", false), &windows_only));
        assert!(!snapshot_available(&fixture_service("wsl", "running", true), &windows_only));
    }
}
