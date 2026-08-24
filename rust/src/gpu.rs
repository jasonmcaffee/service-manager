use crate::error::{AppError, AppResult};
use crate::models::ServiceRow;
use crate::system::{ProcessTable, run_gpu_probe, terminate_windows_pid};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use tokio::process::Command;

pub const VRAM_SAFETY_MARGIN_MB: i64 = 512;

/// One process holding a CUDA context, with the card it holds it on.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuComputeApp {
    /// GPU index the process has a context on, or None when its UUID could not be mapped.
    pub index: Option<u32>,
    pub pid: u32,
    /// Executable basename as nvidia-smi reports it, lowercased.
    pub process_name: String,
}

/// One GPU free/total-memory reading from nvidia-smi.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuMemory {
    pub index: u32,
    pub free_mb: i64,
    pub total_mb: i64,
}

/// Removes comments and expands simple batch variables before GPU-pin inspection.
pub fn normalized_command(command: &str) -> String {
    let mut variables = HashMap::<String, String>::new();
    let mut active_lines = Vec::new();
    let set_pattern = Regex::new(r#"(?i)^\s*set\s+"?([A-Z0-9_]+)=([^"\r\n]+)"?\s*$"#).expect("static set regex");
    for raw_line in command.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("::") || line.starts_with('#') || line.to_ascii_lowercase().starts_with("rem ") { continue; }
        if let Some(capture) = set_pattern.captures(line) { variables.insert(capture[1].to_ascii_uppercase(), capture[2].trim().to_owned()); }
        active_lines.push(line.to_owned());
    }
    let mut result = active_lines.join("\n");
    for (name, value) in variables { result = result.replace(&format!("%{name}%"), &value); }
    result
}

/// Extracts a hard-coded CUDA device mask from the command, excluding injected placeholders.
pub fn command_cuda_device(command: &str) -> Option<String> {
    let normalized = normalized_command(command);
    let patterns = [
        r"(?i)CUDA_VISIBLE_DEVICES\s*=\s*([0-9]+(?:\s*,\s*[0-9]+)*)",
        r"(?i)--cuda-device(?:=|\s+)\s*([0-9]+)",
    ];
    for pattern in patterns {
        let regex = Regex::new(pattern).expect("static CUDA regex");
        if let Some(capture) = regex.captures(&normalized) { return Some(capture[1].replace(' ', "")); }
    }
    // llama.cpp writes its mask as `-dev cuda0,cuda1`. Matching a single `cuda([0-9]+)` read that
    // as a pin to GPU 0 alone, so a dual-card service would have been admitted against — and its
    // orphans reaped on — only half the hardware it actually occupies.
    let device_flag = Regex::new(r##"(?i)(?:^|\s)(?:-dev|--device)(?:=|\s+)\s*"?((?:cuda[0-9]+)(?:\s*,\s*cuda[0-9]+)*)"##).expect("static device mask regex");
    let index = Regex::new(r"(?i)cuda([0-9]+)").expect("static device index regex");
    let mask = device_flag.captures(&normalized)?;
    let devices = index.captures_iter(&mask[1]).map(|capture| capture[1].to_owned()).collect::<Vec<_>>();
    (!devices.is_empty()).then(|| devices.join(","))
}

/// Resolves the command's real GPU pin over the stored profile registration.
pub fn effective_cuda_device(registered: Option<&str>, command: &str) -> Option<String> {
    command_cuda_device(command).or_else(|| registered.map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned))
}

/// Explains a stored-vs-command GPU conflict for API visibility.
pub fn cuda_device_conflict(registered: Option<&str>, command: &str) -> Option<String> {
    let command_pin = command_cuda_device(command)?;
    let registered = registered.map(parse_cuda_devices).unwrap_or_default();
    if registered.is_empty() || registered == parse_cuda_devices(&command_pin) { return None; }
    Some(format!("The start command hard-codes GPU \"{command_pin}\", overriding registered cudaDevice \"{}\".", registered.iter().map(u32::to_string).collect::<Vec<_>>().join(",")))
}

/// Parses a single GPU index or comma-separated device mask.
pub fn parse_cuda_devices(value: &str) -> Vec<u32> {
    let mut devices = value.split(',').filter_map(|part| part.trim().parse::<u32>().ok()).collect::<Vec<_>>();
    devices.sort_unstable();
    devices.dedup();
    devices
}

/// Queries free and total memory for every NVIDIA GPU, returning None when telemetry is unavailable.
pub async fn query_gpu_memory() -> Option<Vec<GpuMemory>> {
    let mut command = Command::new("nvidia-smi.exe");
    command.args(["--query-gpu=index,memory.free,memory.total", "--format=csv,noheader,nounits"]);
    let output = run_gpu_probe(command, "reading GPU memory").await.ok()?;
    if !output.status.success() { return None; }
    Some(parse_gpu_memory(&String::from_utf8_lossy(&output.stdout)))
}

/// Lists every process holding a CUDA context, resolved to the card it is on.
///
/// The compute-apps query reports a `gpu_uuid` rather than an index, and that UUID is the only
/// reliable way to say which card a process is on: passing `-i <index>` to the compute-apps query
/// returns every process on the machine, not that card's. Without the mapping the sweep is
/// device-blind, which is how a stop on one card could reach a process on the other.
pub async fn query_gpu_compute_apps() -> Vec<GpuComputeApp> {
    let mut index_command = Command::new("nvidia-smi.exe");
    index_command.args(["--query-gpu=index,uuid", "--format=csv,noheader,nounits"]);
    let mut apps_command = Command::new("nvidia-smi.exe");
    apps_command.args(["--query-compute-apps=gpu_uuid,pid,process_name", "--format=csv,noheader"]);
    let (uuids, apps) = tokio::join!(run_gpu_probe(index_command, "mapping GPU UUIDs"), run_gpu_probe(apps_command, "listing GPU compute processes"));
    let (Ok(uuids), Ok(apps)) = (uuids, apps) else { return Vec::new() };
    if !uuids.status.success() || !apps.status.success() { return Vec::new(); }
    parse_gpu_compute_apps(&String::from_utf8_lossy(&apps.stdout), &parse_gpu_uuid_index(&String::from_utf8_lossy(&uuids.stdout)))
}

/// Parses `index,uuid` rows into the UUID-to-index lookup the compute-apps query needs.
pub fn parse_gpu_uuid_index(output: &str) -> HashMap<String, u32> {
    output.lines().filter_map(|line| {
        let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
        Some((fields.get(1)?.to_string(), fields.first()?.parse().ok()?))
    }).collect()
}

/// Parses `gpu_uuid,pid,process_name` rows into structured compute processes.
pub fn parse_gpu_compute_apps(output: &str, uuid_to_index: &HashMap<String, u32>) -> Vec<GpuComputeApp> {
    output.lines().filter_map(|line| {
        let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
        if fields.len() < 3 { return None; }
        let pid = fields[1].parse::<u32>().ok()?;
        let process_name = std::path::Path::new(fields[2]).file_name().and_then(|value| value.to_str()).unwrap_or(fields[2]).to_ascii_lowercase();
        Some(GpuComputeApp { index: uuid_to_index.get(fields[0]).copied(), pid, process_name })
    }).collect()
}

/// Parses nvidia-smi GPU memory CSV rows.
pub fn parse_gpu_memory(output: &str) -> Vec<GpuMemory> {
    output.lines().filter_map(|line| {
        let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
        Some(GpuMemory { index: fields.first()?.parse().ok()?, free_mb: fields.get(1)?.parse().ok()?, total_mb: fields.get(2)?.parse().ok()? })
    }).collect()
}

/// Enforces the configured VRAM threshold on every device a service will actually use.
pub async fn assert_vram_available(service: &ServiceRow, registered: Option<&str>, occupants: &HashMap<u32, Vec<String>>) -> AppResult<()> {
    let Some(required_mb) = service.min_free_vram_mb.filter(|value| *value > 0) else { return Ok(()) };
    let devices = effective_cuda_device(registered, &service.command).map(|value| parse_cuda_devices(&value)).unwrap_or_default();
    if devices.is_empty() { return Ok(()); }
    let Some(readings) = query_gpu_memory().await else { return Ok(()) };
    for device in devices {
        let Some(reading) = readings.iter().find(|reading| reading.index == device) else { continue };
        let threshold = required_mb + VRAM_SAFETY_MARGIN_MB;
        if reading.free_mb >= threshold { continue; }
        let held_by = occupants.get(&device).filter(|names| !names.is_empty()).map(|names| format!(" Held by: {}.", names.join(", "))).unwrap_or_default();
        return Err(AppError::Conflict(format!("Cannot start {}: GPU {} has {} MB free, but {} MB is required including the {} MB safety margin.{}", service.name, device, reading.free_mb, threshold, VRAM_SAFETY_MARGIN_MB, held_by)));
    }
    Ok(())
}

/// Returns specific executable basenames a service command launches, excluding generic interpreters.
pub fn command_executables(command: &str) -> HashSet<String> {
    let generic = ["python.exe", "python3.exe", "node.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "wsl.exe", "bash.exe"];
    let regex = Regex::new(r"(?i)([A-Za-z0-9_.-]+\.exe)\b").expect("static executable regex");
    regex.captures_iter(&normalized_command(command)).map(|capture| capture[1].to_ascii_lowercase()).filter(|name| !generic.contains(&name.as_str())).collect()
}

/// Splits the processes on a service's cards into its own reapable leftovers and everything else.
///
/// A survivor is only attributed to the service when its executable is named in that service's own
/// start command, is specific enough to identify (never a bare `python.exe`), is not claimed by
/// another registered service, and is not protected. That is what makes reaping safe to do
/// automatically. Anything on the same cards belonging to a DIFFERENT registered service is
/// reported and never touched; everything else is dropped, because on this box the per-process
/// table lists every compositing desktop app and reporting those would bury the line that matters.
/// @param owned_names - executables the stopped service's own command launches
/// @param foreign - executable name to owning service name, for the other registered services
pub fn classify_gpu_survivors(apps: &[GpuComputeApp], devices: &[u32], owned_names: &HashSet<String>, foreign: &HashMap<String, String>, protected_pids: &HashSet<u32>, process_table: &ProcessTable) -> (Vec<GpuComputeApp>, Vec<(GpuComputeApp, String)>) {
    let mut reapable = Vec::new();
    let mut report_only = Vec::new();
    for app in apps {
        // A process whose card could not be resolved is still considered: dropping it would
        // silently skip the very orphan the sweep exists to find.
        if app.index.is_some_and(|index| !devices.contains(&index)) { continue; }
        if owned_names.contains(&app.process_name) && !foreign.contains_key(&app.process_name) {
            if protected_pids.contains(&app.pid) { report_only.push((app.clone(), "a protected process".to_owned())); continue; }
            let table_name = process_table.name_by_pid.get(&app.pid).map(|value| value.to_ascii_lowercase()).unwrap_or_default();
            if !table_name.is_empty() && table_name != app.process_name { continue; }
            reapable.push(app.clone());
            continue;
        }
        if let Some(owner) = foreign.get(&app.process_name) { report_only.push((app.clone(), owner.clone())); }
    }
    (reapable, report_only)
}

/// Describes one GPU process for a person reading the service's own event history.
fn describe_app(app: &GpuComputeApp) -> String {
    let where_text = app.index.map(|index| format!(" on GPU {index}")).unwrap_or_default();
    format!("{} (pid {}){where_text}", app.process_name, app.pid)
}

/// Reaps a service's own leftover GPU processes on the cards it is pinned to, and reports the rest.
///
/// Stopping a service used to report success while a second `llama-server.exe` from an earlier
/// start still held 30 GB — invisible in the service list and findable only in nvidia-smi's
/// per-process table (task-1493). The evidence half matters as much as the kill: what was left
/// behind, who owns it, and what the card actually reads afterwards, because per-process VRAM is
/// never reported on Windows WDDM so the card-level figure is the only honest measure.
pub async fn reap_owned_gpu_orphans(service: &ServiceRow, registered: Option<&str>, all_services: &[ServiceRow], process_table: &ProcessTable, protected_pids: &HashSet<u32>) -> AppResult<Vec<String>> {
    let devices = effective_cuda_device(registered, &service.command).map(|value| parse_cuda_devices(&value)).unwrap_or_default();
    let owned_names = command_executables(&service.command);
    if devices.is_empty() || owned_names.is_empty() { return Ok(Vec::new()); }
    let apps = query_gpu_compute_apps().await;
    if apps.is_empty() { return Ok(Vec::new()); }
    let foreign = known_executables(all_services, &service.id);
    let (reapable, report_only) = classify_gpu_survivors(&apps, &devices, &owned_names, &foreign, protected_pids, process_table);

    let mut notes = Vec::new();
    for app in &reapable {
        match terminate_windows_pid(app.pid, false).await {
            Ok(()) => notes.push(format!("Reaped leftover GPU process: {}.", describe_app(app))),
            Err(error) => notes.push(format!("WARNING: could not kill leftover {} - {error}.", describe_app(app))),
        }
    }
    for (app, owner) in &report_only {
        notes.push(format!("Still on this service's GPU: {} - belongs to {owner}, left running.", describe_app(app)));
    }
    if !notes.is_empty() {
        let readings = query_gpu_memory().await.unwrap_or_default();
        for device in &devices {
            if let Some(reading) = readings.iter().find(|reading| reading.index == *device) {
                notes.push(format!("GPU {device} now has {} MB free of {} MB.", reading.free_mb, reading.total_mb));
            }
        }
    }
    Ok(notes)
}

/// Maps executable basenames to the OTHER registered service that owns them.
///
/// Lets a process left on a shared card be named ("that is ComfyUI") rather than reported as an
/// anonymous PID or dropped as noise.
/// @param exclude_service_id - the service being acted on, whose binaries are handled separately
pub fn known_executables(services: &[ServiceRow], exclude_service_id: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for service in services.iter().filter(|candidate| candidate.id != exclude_service_id) {
        for executable in command_executables(&service.command) { map.entry(executable).or_insert_with(|| service.name.clone()); }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Commented and injected pins must not override the registered device.
    #[test]
    fn command_pin_parser_ignores_comments_and_placeholders() {
        assert_eq!(command_cuda_device("REM --cuda-device 0\nset CUDA_VISIBLE_DEVICES=%CUDA_DEVICE%\npython main.py"), None);
        assert_eq!(command_cuda_device("set CUDA_STRING=cuda1\nllama-server.exe -dev %CUDA_STRING%"), Some("1".into()));
    }

    /// Multi-device masks are normalized and deduplicated.
    #[test]
    fn cuda_masks_are_normalized() {
        assert_eq!(parse_cuda_devices("1, 0,1"), vec![0, 1]);
    }

    /// A llama.cpp dual-card mask resolves to both devices, not just the first.
    #[test]
    fn device_masks_cover_every_named_card() {
        assert_eq!(command_cuda_device("llama-server.exe -dev cuda0,cuda1 --port 8080"), Some("0,1".into()));
        assert_eq!(command_cuda_device("llama-server.exe -dev cuda1"), Some("1".into()));
        assert_eq!(command_cuda_device("llama-server.exe -dev cuda%CUDA_DEVICE%"), None);
    }

    /// The sweep only ever considers processes on the cards the service is pinned to.
    #[test]
    fn survivor_classification_is_scoped_to_the_services_own_cards() {
        let apps = vec![
            GpuComputeApp { index: Some(1), pid: 10, process_name: "llama-server.exe".into() },
            GpuComputeApp { index: Some(0), pid: 11, process_name: "llama-server.exe".into() },
            GpuComputeApp { index: None, pid: 12, process_name: "llama-server.exe".into() },
            GpuComputeApp { index: Some(1), pid: 13, process_name: "comfyui.exe".into() },
        ];
        let owned = HashSet::from(["llama-server.exe".to_owned()]);
        let foreign = HashMap::from([("comfyui.exe".to_owned(), "ComfyUI".to_owned())]);
        let table = ProcessTable::default();
        let (reapable, reported) = classify_gpu_survivors(&apps, &[1], &owned, &foreign, &HashSet::new(), &table);
        assert_eq!(reapable.iter().map(|app| app.pid).collect::<Vec<_>>(), vec![10, 12], "GPU 0's process must be left alone");
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0].1, "ComfyUI");
    }

    /// A protected PID is reported rather than killed, even when the name matches.
    #[test]
    fn protected_survivors_are_reported_not_reaped() {
        let apps = vec![GpuComputeApp { index: Some(0), pid: 20, process_name: "llama-server.exe".into() }];
        let owned = HashSet::from(["llama-server.exe".to_owned()]);
        let (reapable, reported) = classify_gpu_survivors(&apps, &[0], &owned, &HashMap::new(), &HashSet::from([20]), &ProcessTable::default());
        assert!(reapable.is_empty());
        assert_eq!(reported.len(), 1);
    }

    /// Generic interpreters are never candidates for GPU orphan termination.
    #[test]
    fn executable_parser_excludes_generic_interpreters() {
        let names = command_executables("python.exe app.py && llama-server.exe -m x");
        assert!(!names.contains("python.exe"));
        assert!(names.contains("llama-server.exe"));
    }
}
