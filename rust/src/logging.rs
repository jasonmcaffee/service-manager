use crate::error::{AppError, AppResult};
use chrono::Local;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;
pub const INITIAL_TAIL_BYTES: u64 = 512 * 1024;
const EVENT_KEEP_BYTES: u64 = 2 * 1024 * 1024;

/// Resolves the durable run log path for one service.
pub fn run_log_path(runtime_root: &Path, service_id: &str) -> PathBuf {
    runtime_root.join("logs").join(format!("service-{service_id}.log"))
}

/// Resolves the append-only Service Manager event log path for one service.
pub fn event_log_path(runtime_root: &Path, service_id: &str) -> PathBuf {
    runtime_root.join("logs").join(format!("service-{service_id}.events.log"))
}

/// Appends a timestamped manager event and bounds its history without touching the run log.
pub fn append_service_event(runtime_root: &Path, service_id: &str, message: &str) -> AppResult<()> {
    let path = event_log_path(runtime_root, service_id);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| AppError::internal("creating event log directory", error))?; }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)
        .map_err(|error| AppError::internal("opening service event log", error))?;
    writeln!(file, "[{}] {}", Local::now().format("%Y-%m-%d %H:%M:%S"), message)
        .map_err(|error| AppError::internal("writing service event", error))?;
    cap_file(&path, EVENT_KEEP_BYTES, EVENT_KEEP_BYTES / 2)?;
    Ok(())
}

/// Returns the newest bounded run-log lines for the output API.
pub fn read_run_log(runtime_root: &Path, service_id: &str, line_limit: usize) -> AppResult<Vec<String>> {
    read_tail_lines(&run_log_path(runtime_root, service_id), INITIAL_TAIL_BYTES, line_limit)
}

/// Returns durable Service Manager events in chronological order.
pub fn read_service_events(runtime_root: &Path, service_id: &str, line_limit: usize) -> AppResult<Vec<String>> {
    read_tail_lines(&event_log_path(runtime_root, service_id), EVENT_KEEP_BYTES, line_limit)
}

/// Truncates a service run log while preserving its durable event history.
pub fn clear_run_log(runtime_root: &Path, service_id: &str) -> AppResult<()> {
    let path = run_log_path(runtime_root, service_id);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| AppError::internal("creating run log directory", error))?; }
    File::create(path).map_err(|error| AppError::internal("clearing service output", error))?;
    Ok(())
}

/// Bounds every run log so service output cannot grow the manager's memory or disk indefinitely.
pub fn cap_all_run_logs(runtime_root: &Path) -> AppResult<()> {
    let directory = runtime_root.join("logs");
    if !directory.exists() { return Ok(()); }
    for entry in fs::read_dir(directory).map_err(|error| AppError::internal("reading service logs", error))? {
        let path = entry.map_err(|error| AppError::internal("reading service log entry", error))?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("log") || path.to_string_lossy().ends_with("events.log") { continue; }
        cap_file(&path, MAX_LOG_BYTES, MAX_LOG_BYTES / 2)?;
    }
    Ok(())
}

/// Reads a byte-bounded file tail and returns at most the newest requested lines.
fn read_tail_lines(path: &Path, byte_limit: u64, line_limit: usize) -> AppResult<Vec<String>> {
    if !path.exists() { return Ok(Vec::new()); }
    let mut file = File::open(path).map_err(|error| AppError::internal("opening service log", error))?;
    let length = file.metadata().map_err(|error| AppError::internal("reading service log metadata", error))?.len();
    let start = length.saturating_sub(byte_limit);
    file.seek(SeekFrom::Start(start)).map_err(|error| AppError::internal("seeking service log", error))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes).map_err(|error| AppError::internal("reading service log", error))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    if start > 0 && !lines.is_empty() { lines.remove(0); }
    if lines.len() > line_limit { lines.drain(0..lines.len() - line_limit); }
    Ok(lines)
}

/// Rewrites an oversized log with only its newest bytes.
fn cap_file(path: &Path, max_bytes: u64, keep_bytes: u64) -> AppResult<()> {
    let metadata = fs::metadata(path).map_err(|error| AppError::internal("reading log size", error))?;
    if metadata.len() <= max_bytes { return Ok(()); }
    let mut source = File::open(path).map_err(|error| AppError::internal("opening oversized log", error))?;
    source.seek(SeekFrom::End(-(keep_bytes as i64))).map_err(|error| AppError::internal("seeking oversized log", error))?;
    let mut bytes = Vec::with_capacity(keep_bytes as usize);
    source.read_to_end(&mut bytes).map_err(|error| AppError::internal("reading oversized log tail", error))?;
    fs::write(path, bytes).map_err(|error| AppError::internal("capping oversized log", error))?;
    Ok(())
}

