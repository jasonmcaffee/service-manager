use crate::error::{AppError, AppResult};
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tokio::process::Command;

/// One operating-system process snapshot used by exact-PID safety checks.
#[derive(Clone, Debug, Default)]
pub struct ProcessTable {
    pub parent_by_pid: HashMap<u32, u32>,
    pub command_by_pid: HashMap<u32, String>,
    pub name_by_pid: HashMap<u32, String>,
}

/// Windows and WSL exact-port listener maps captured once per reconcile pass.
#[derive(Clone, Debug, Default)]
pub struct ListenerSnapshot {
    pub windows: Option<HashMap<u16, Vec<u32>>>,
    pub wsl: Option<HashMap<u16, Vec<u32>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimProcess {
    process_id: u32,
    parent_process_id: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    command_line: Option<String>,
}

/// Captures Windows and WSL listeners independently so one failed probe does not erase the other.
pub async fn snapshot_listeners() -> ListenerSnapshot {
    let (windows, wsl) = tokio::join!(windows_listeners(), wsl_listeners());
    ListenerSnapshot { windows: windows.ok(), wsl: wsl.ok() }
}

/// Parses exact TCP LISTENING rows from netstat without port-substring matching.
pub async fn windows_listeners() -> AppResult<HashMap<u16, Vec<u32>>> {
    let output = Command::new("netstat.exe").args(["-ano"]).output().await
        .map_err(|error| AppError::internal("running netstat", error))?;
    if !output.status.success() { return Err(AppError::internal("running netstat", "non-zero exit")); }
    Ok(parse_netstat(&String::from_utf8_lossy(&output.stdout)))
}

/// Captures WSL listener PIDs using ss and falls back to an empty successful map.
pub async fn wsl_listeners() -> AppResult<HashMap<u16, Vec<u32>>> {
    let script = "ss -ltnpH 2>/dev/null || true; echo __SM_FUSER__; for port in $(ss -ltnH 2>/dev/null | awk '{print $4}' | awk -F: '{print $NF}' | tr -d ']' | sort -nu); do pids=$(fuser -n tcp \"$port\" 2>/dev/null); [ -n \"$pids\" ] && echo \"$port $pids\"; done";
    let output = Command::new("wsl.exe").args(["sh", "-lc", script]).output().await
        .map_err(|error| AppError::internal("running WSL listener snapshot", error))?;
    if !output.status.success() { return Err(AppError::internal("running WSL listener snapshot", "non-zero exit")); }
    Ok(parse_wsl_snapshot(&String::from_utf8_lossy(&output.stdout)))
}

/// Combines `ss` process metadata with a `fuser` fallback for listeners lacking users data.
pub fn parse_wsl_snapshot(output: &str) -> HashMap<u16, Vec<u32>> {
    let (ss_output, fuser_output) = output.split_once("__SM_FUSER__").unwrap_or((output, ""));
    let mut listeners = parse_wsl_ss(ss_output);
    for line in fuser_output.lines() {
        let mut fields = line.split_whitespace();
        let Some(port) = fields.next().and_then(|value| value.parse::<u16>().ok()) else { continue };
        for pid in fields.filter_map(|value| value.parse::<u32>().ok()) {
            let entry = listeners.entry(port).or_default();
            if !entry.contains(&pid) { entry.push(pid); }
        }
    }
    listeners
}

/// Parses Windows netstat rows into exact port-to-PID ownership.
pub fn parse_netstat(output: &str) -> HashMap<u16, Vec<u32>> {
    let mut listeners = HashMap::new();
    for line in output.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("TCP") || !fields[3].eq_ignore_ascii_case("LISTENING") { continue; }
        let Some(port) = fields[1].rsplit(':').next().and_then(|value| value.parse::<u16>().ok()) else { continue };
        let Some(pid) = fields[4].parse::<u32>().ok() else { continue };
        let entry = listeners.entry(port).or_insert_with(Vec::new);
        if !entry.contains(&pid) { entry.push(pid); }
    }
    listeners
}

/// Parses Linux ss listener output and extracts process PIDs.
pub fn parse_wsl_ss(output: &str) -> HashMap<u16, Vec<u32>> {
    let pid_pattern = Regex::new(r"pid=(\d+)").expect("static WSL PID regex");
    let mut listeners = HashMap::new();
    for line in output.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let Some(local) = fields.get(3).or_else(|| fields.get(0)) else { continue };
        let Some(port) = local.rsplit(':').next().and_then(|value| value.trim_end_matches(']').parse::<u16>().ok()) else { continue };
        for capture in pid_pattern.captures_iter(line) {
            let Some(pid) = capture[1].parse::<u32>().ok() else { continue };
            let entry = listeners.entry(port).or_insert_with(Vec::new);
            if !entry.contains(&pid) { entry.push(pid); }
        }
    }
    listeners
}

/// Captures PID, parent, name, and command line in one bounded CIM query.
pub async fn snapshot_process_table() -> AppResult<ProcessTable> {
    let script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    let output = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().await
        .map_err(|error| AppError::internal("capturing Windows process table", error))?;
    if !output.status.success() { return Err(AppError::internal("capturing Windows process table", "non-zero exit")); }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| AppError::internal("decoding Windows process table", error))?;
    let rows = if value.is_array() { serde_json::from_value::<Vec<CimProcess>>(value) } else { serde_json::from_value::<CimProcess>(value).map(|row| vec![row]) }
        .map_err(|error| AppError::internal("decoding Windows processes", error))?;
    let mut table = ProcessTable::default();
    for row in rows {
        table.parent_by_pid.insert(row.process_id, row.parent_process_id);
        table.name_by_pid.insert(row.process_id, row.name);
        table.command_by_pid.insert(row.process_id, row.command_line.unwrap_or_default());
    }
    Ok(table)
}

/// Returns a PID and every ancestor while defending against corrupt parent cycles.
pub fn ancestors_of(pid: u32, parent_by_pid: &HashMap<u32, u32>) -> Vec<u32> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut current = pid;
    while current > 0 && seen.insert(current) {
        result.push(current);
        current = *parent_by_pid.get(&current).unwrap_or(&0);
    }
    result
}

/// Terminates one exact Windows PID, optionally including only its recorded spawned tree.
pub async fn terminate_windows_pid(pid: u32, tree: bool) -> AppResult<()> {
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string(), "/F"]);
    if tree { command.arg("/T"); }
    let output = command.output().await.map_err(|error| AppError::internal("terminating exact Windows PID", error))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::warn!(pid, tree, %detail, "exact Windows PID termination returned non-zero");
    }
    Ok(())
}

/// Terminates one exact WSL PID with TERM followed by a bounded KILL fallback.
pub async fn terminate_wsl_pid(pid: u32) -> AppResult<()> {
    let script = format!("kill -TERM {pid} 2>/dev/null || true; sleep 0.2; kill -KILL {pid} 2>/dev/null || true");
    Command::new("wsl.exe").args(["sh", "-lc", &script]).output().await
        .map_err(|error| AppError::internal("terminating exact WSL PID", error))?;
    Ok(())
}

/// Deletes only portproxy rules whose listen port exactly matches the service port.
pub async fn delete_port_proxy_rules(port: u16) -> AppResult<()> {
    let output = Command::new("netsh.exe").args(["interface", "portproxy", "show", "all"]).output().await;
    let Ok(output) = output else { return Ok(()) };
    for address in parse_port_proxy_addresses(&String::from_utf8_lossy(&output.stdout), port) {
        let port_text = port.to_string();
        let result = Command::new("netsh.exe").args(["interface", "portproxy", "delete", "v4tov4", &format!("listenaddress={address}"), &format!("listenport={port_text}")]).output().await;
        if result.as_ref().is_err() || result.as_ref().is_ok_and(|value| !value.status.success()) { tracing::warn!(port, %address, "could not delete exact WSL portproxy rule"); }
    }
    Ok(())
}

/// Ensures a WSL listener is reachable from Windows without creating mirrored-network self-loops.
pub async fn ensure_wsl_port_proxy(port: u16) -> AppResult<()> {
    if windows_listeners().await.ok().is_some_and(|listeners| listeners.contains_key(&port)) { return Ok(()) }
    let ip_output = Command::new("wsl.exe").args(["sh", "-lc", "ip -4 addr show eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1"]).output().await;
    let Some(wsl_ip) = ip_output.ok().filter(|value| value.status.success()).and_then(|value| String::from_utf8(value.stdout).ok()).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()) else { tracing::warn!(port, "could not determine WSL IP for portproxy"); return Ok(()) };
    let windows_network = Command::new("ipconfig.exe").output().await.ok().map(|value| String::from_utf8_lossy(&value.stdout).into_owned()).unwrap_or_default();
    if windows_network.contains(&wsl_ip) { tracing::warn!(port, %wsl_ip, "WSL mirrored networking detected; portproxy is unnecessary"); return Ok(()) }
    let result = Command::new("netsh.exe").args(["interface", "portproxy", "add", "v4tov4", "listenaddress=0.0.0.0", &format!("listenport={port}"), &format!("connectaddress={wsl_ip}"), &format!("connectport={port}")]).output().await;
    if result.as_ref().is_err() || result.as_ref().is_ok_and(|value| !value.status.success()) { tracing::warn!(port, %wsl_ip, "could not create exact WSL portproxy rule"); }
    Ok(())
}

/// Parses exact v4tov4 listen addresses from `netsh interface portproxy show all`.
fn parse_port_proxy_addresses(output: &str, port: u16) -> Vec<String> {
    output.lines().filter_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        (fields.len() >= 4 && fields[1].parse::<u16>().ok() == Some(port)).then(|| fields[0].to_owned())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact parsing must never match port 80 against an 8080 listener.
    #[test]
    fn netstat_parser_matches_exact_ports() {
        let parsed = parse_netstat("TCP 0.0.0.0:80 0.0.0.0:0 LISTENING 10\nTCP 0.0.0.0:8080 0.0.0.0:0 LISTENING 20");
        assert_eq!(parsed.get(&80), Some(&vec![10]));
        assert_eq!(parsed.get(&8080), Some(&vec![20]));
    }

    /// Fuser fills PID gaps left by restricted `ss` process metadata without duplicating PIDs.
    #[test]
    fn wsl_snapshot_combines_ss_and_fuser() {
        let parsed = parse_wsl_snapshot("LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:((\"python\",pid=10,fd=3))\nLISTEN 0 128 127.0.0.1:9000 0.0.0.0:*\n__SM_FUSER__\n8000 10\n9000 20 21");
        assert_eq!(parsed.get(&8000), Some(&vec![10]));
        assert_eq!(parsed.get(&9000), Some(&vec![20, 21]));
    }

    /// Portproxy parsing compares full numeric ports and ignores adjacent values.
    #[test]
    fn port_proxy_parser_matches_exact_port() {
        let output = "0.0.0.0 80 172.20.0.2 80\n0.0.0.0 8080 172.20.0.2 8080";
        assert_eq!(parse_port_proxy_addresses(output, 80), vec!["0.0.0.0"]);
    }

    /// Parent cycles terminate without looping forever.
    #[test]
    fn ancestor_cycle_is_bounded() {
        let parents = HashMap::from([(10, 11), (11, 10)]);
        assert_eq!(ancestors_of(10, &parents), vec![10, 11]);
    }
}
