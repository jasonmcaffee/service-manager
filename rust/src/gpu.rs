use crate::error::{AppError, AppResult};
use crate::models::ServiceRow;
use crate::system::{ProcessTable, terminate_windows_pid};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use tokio::process::Command;

pub const VRAM_SAFETY_MARGIN_MB: i64 = 512;

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
        r"(?i)-dev(?:=|\s+)\s*cuda([0-9]+)",
    ];
    for pattern in patterns {
        let regex = Regex::new(pattern).expect("static CUDA regex");
        if let Some(capture) = regex.captures(&normalized) { return Some(capture[1].replace(' ', "")); }
    }
    None
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
    let output = Command::new("nvidia-smi.exe").args(["--query-gpu=index,memory.free,memory.total", "--format=csv,noheader,nounits"]).output().await.ok()?;
    if !output.status.success() { return None; }
    Some(parse_gpu_memory(&String::from_utf8_lossy(&output.stdout)))
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

/// Reaps only compute processes whose specific executable belongs uniquely to the selected service.
pub async fn reap_owned_gpu_orphans(service: &ServiceRow, registered: Option<&str>, all_services: &[ServiceRow], process_table: &ProcessTable, protected_pids: &HashSet<u32>) -> AppResult<Vec<String>> {
    let devices = effective_cuda_device(registered, &service.command).map(|value| parse_cuda_devices(&value)).unwrap_or_default();
    let owned_names = command_executables(&service.command);
    if devices.is_empty() || owned_names.is_empty() { return Ok(Vec::new()); }
    let foreign_names = all_services.iter().filter(|candidate| candidate.id != service.id).flat_map(|candidate| command_executables(&candidate.command)).collect::<HashSet<_>>();
    let output = Command::new("nvidia-smi.exe").args(["--query-compute-apps=pid,process_name", "--format=csv,noheader"]).output().await;
    let Ok(output) = output else { return Ok(Vec::new()) };
    if !output.status.success() { return Ok(Vec::new()); }
    let mut notes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
        let Some(pid) = fields.first().and_then(|value| value.parse::<u32>().ok()) else { continue };
        let name = fields.get(1).and_then(|value| std::path::Path::new(value).file_name()).and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
        if !owned_names.contains(&name) || foreign_names.contains(&name) || protected_pids.contains(&pid) { continue; }
        let table_name = process_table.name_by_pid.get(&pid).map(|value| value.to_ascii_lowercase()).unwrap_or_default();
        if !table_name.is_empty() && table_name != name { continue; }
        terminate_windows_pid(pid, false).await?;
        notes.push(format!("Reaped owned GPU orphan {name} PID {pid}."));
    }
    Ok(notes)
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

    /// Generic interpreters are never candidates for GPU orphan termination.
    #[test]
    fn executable_parser_excludes_generic_interpreters() {
        let names = command_executables("python.exe app.py && llama-server.exe -m x");
        assert!(!names.contains("python.exe"));
        assert!(names.contains("llama-server.exe"));
    }
}
