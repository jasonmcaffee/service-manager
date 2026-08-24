use crate::error::{AppError, AppResult};
use chrono::{Local, SecondsFormat, Utc};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;
pub const KEEP_LOG_BYTES: u64 = MAX_LOG_BYTES / 2;
pub const INITIAL_TAIL_BYTES: u64 = 512 * 1024;
const EVENT_KEEP_BYTES: u64 = 2 * 1024 * 1024;
const NEWLINE: u8 = 10;

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

/// Returns run-log lines written after a byte offset, so a cleared service starts blank.
///
/// Clearing cannot truncate the file: the log pump the service's wrapper pipes through owns the
/// only write handle, and an outside truncate fails with a sharing violation while the service is
/// running. Recording where the caller cleared and reading from there reproduces exactly what the
/// old in-memory ring buffer did, without fighting the handle.
/// @param minimum_offset - byte offset the last clear recorded for this service
pub fn read_run_log_from(runtime_root: &Path, service_id: &str, minimum_offset: u64, line_limit: usize) -> AppResult<Vec<String>> {
    read_tail_lines(&run_log_path(runtime_root, service_id), INITIAL_TAIL_BYTES, minimum_offset, line_limit)
}

/// Returns the current size of a service's run log, used to anchor a clear.
pub fn run_log_size(runtime_root: &Path, service_id: &str) -> u64 {
    fs::metadata(run_log_path(runtime_root, service_id)).map(|metadata| metadata.len()).unwrap_or(0)
}

/// Returns durable Service Manager events in chronological order.
pub fn read_service_events(runtime_root: &Path, service_id: &str, line_limit: usize) -> AppResult<Vec<String>> {
    read_tail_lines(&event_log_path(runtime_root, service_id), EVENT_KEEP_BYTES, 0, line_limit)
}

/// Truncates a service run log when nothing holds it, without failing when something does.
///
/// A running service's wrapper pipes through the log pump, which holds the only write handle, so an
/// outside truncate is a sharing violation rather than a bug. Callers that need "the output looks
/// empty from here" use the clear offset instead; this is only the best-effort file reset performed
/// before a fresh start, where the wrapper has already been reaped.
pub fn clear_run_log(runtime_root: &Path, service_id: &str) -> AppResult<()> {
    let path = run_log_path(runtime_root, service_id);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| AppError::internal("creating run log directory", error))?; }
    if let Err(error) = File::create(&path) { tracing::debug!(service_id, %error, "run log is held by its pump; leaving the file in place"); }
    Ok(())
}

/// Bounds the run logs of services that are not currently writing, and never fails the caller.
///
/// A live service's log is capped in place by its own pump, which owns the write handle; this sweep
/// exists only for logs left oversized by a service that has since stopped, or by a manager version
/// that predates the pump. It deliberately swallows per-file errors: this used to be the last
/// statement of the reconcile pass, so one log held open by a running service aborted every tick —
/// auto-restart supervision included — for as long as that service stayed up.
pub fn cap_all_run_logs(runtime_root: &Path) -> AppResult<()> {
    let directory = runtime_root.join("logs");
    if !directory.exists() { return Ok(()); }
    let entries = match fs::read_dir(directory) { Ok(entries) => entries, Err(error) => { tracing::warn!(%error, "could not list service logs to cap"); return Ok(()); } };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("log") || path.to_string_lossy().ends_with("events.log") { continue; }
        if let Err(error) = cap_file(&path, MAX_LOG_BYTES, KEEP_LOG_BYTES) { tracing::debug!(path = %path.display(), %error, "skipped capping a log that is in use"); }
    }
    Ok(())
}

/// Reads a byte-bounded file tail after an optional floor offset and returns the newest lines.
fn read_tail_lines(path: &Path, byte_limit: u64, minimum_offset: u64, line_limit: usize) -> AppResult<Vec<String>> {
    if !path.exists() { return Ok(Vec::new()); }
    let mut file = File::open(path).map_err(|error| AppError::internal("opening service log", error))?;
    let length = file.metadata().map_err(|error| AppError::internal("reading service log metadata", error))?.len();
    // A clear offset past the current length means the log was rewritten (a fresh start, or the
    // pump trimming it) after the clear, so the whole file is newer than the clear and is shown.
    let floor = if minimum_offset > length { 0 } else { minimum_offset };
    let start = length.saturating_sub(byte_limit).max(floor);
    file.seek(SeekFrom::Start(start)).map_err(|error| AppError::internal("seeking service log", error))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes).map_err(|error| AppError::internal("reading service log", error))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    if start > 0 && start != floor && !lines.is_empty() { lines.remove(0); }
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

/// Prefixes every newline-started line of a chunk with an ISO-8601 UTC timestamp.
///
/// Stamps on `\n` ONLY, never on `\r`. Progress bars (tqdm and anything else that redraws a line)
/// emit many carriage-returned updates per second; stamping those would multiply the file size,
/// blow through the cap, and turn one readable progress line into hundreds. Tracebacks and ordinary
/// output are newline-delimited, so they get dated while redrawing bars are left exactly as they
/// were. Works on raw bytes so a service emitting non-UTF-8 output cannot be corrupted.
/// @param chunk - raw bytes read from the service's combined stdout/stderr
/// @param at_line_start - whether the next byte begins a fresh line and therefore wants a stamp
pub fn stamp_lines(chunk: &[u8], at_line_start: &mut bool) -> Vec<u8> {
    if chunk.is_empty() { return Vec::new(); }
    let prefix = format!("[{}] ", Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)).into_bytes();
    let mut out = Vec::with_capacity(chunk.len() + prefix.len() * 2);
    if *at_line_start { out.extend_from_slice(&prefix); *at_line_start = false; }
    let mut start = 0usize;
    for index in 0..chunk.len() {
        if chunk[index] != NEWLINE { continue; }
        out.extend_from_slice(&chunk[start..=index]);
        start = index + 1;
        if start < chunk.len() { out.extend_from_slice(&prefix); } else { *at_line_start = true; }
    }
    if start < chunk.len() { out.extend_from_slice(&chunk[start..]); }
    out
}

/// Pumps a managed service's combined output into its run log, timestamped and size-capped.
///
/// Each managed service's wrapper script pipes through this mode of the manager binary, so this
/// process is the SOLE writer of that log file and can therefore trim it in place. The manager
/// itself cannot: the wrapper holds the file with a write handle no outside truncate can take, which
/// is why capping from the reconcile loop silently never worked and why clearing output 500'd for
/// every running service. Runs before any async runtime is started and never returns until stdin
/// closes, which happens when the service exits or is killed.
/// @param log_file - absolute path of the run log to own
/// @param max_bytes - size at which the log is trimmed
/// @param keep_bytes - how much of the tail to keep when trimming
pub fn run_log_pump(log_file: &Path, max_bytes: u64, keep_bytes: u64) -> std::io::Result<()> {
    if let Some(parent) = log_file.parent() { fs::create_dir_all(parent)?; }
    let mut file = OpenOptions::new().create(true).append(true).open(log_file)?;
    let mut size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut at_line_start = true;
    let mut buffer = [0u8; 64 * 1024];
    let mut stdin = std::io::stdin().lock();
    loop {
        let read = match stdin.read(&mut buffer) { Ok(0) => break, Ok(read) => read, Err(_) => break };
        let stamped = stamp_lines(&buffer[..read], &mut at_line_start);
        // A transient write failure must never stop the pump: losing one chunk of output is far
        // better than losing every line the service produces from that point on.
        if file.write_all(&stamped).is_ok() { size += stamped.len() as u64; }
        if size > max_bytes {
            drop(file);
            trim_owned_log(log_file, keep_bytes)?;
            file = OpenOptions::new().create(true).append(true).open(log_file)?;
            size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        }
    }
    Ok(())
}

/// Rewrites a log this process exclusively owns down to its newest bytes, with a marker.
fn trim_owned_log(log_file: &Path, keep_bytes: u64) -> std::io::Result<()> {
    let metadata = fs::metadata(log_file)?;
    let start = metadata.len().saturating_sub(keep_bytes);
    let mut source = File::open(log_file)?;
    source.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(keep_bytes as usize);
    source.read_to_end(&mut bytes)?;
    drop(source);
    let marker = format!("\n... [service-manager: log trimmed to its last {} MB (cap {} MB)] ...\n", keep_bytes / 1_048_576, MAX_LOG_BYTES / 1_048_576);
    let mut rewritten = marker.into_bytes();
    rewritten.extend_from_slice(&bytes);
    fs::write(log_file, rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Newline-delimited output is dated while carriage-returned progress bars are left untouched.
    #[test]
    fn stamping_dates_lines_without_touching_progress_bars() {
        let mut at_line_start = true;
        let stamped = String::from_utf8(stamp_lines(b"first\nsecond\n", &mut at_line_start)).expect("utf8");
        assert_eq!(stamped.lines().count(), 2);
        assert!(stamped.lines().all(|line| line.starts_with('[')));
        assert!(at_line_start);

        let mut bar_start = true;
        let bar = String::from_utf8(stamp_lines(b"\r 50%|#####| 5/10\r 60%|######| 6/10", &mut bar_start)).expect("utf8");
        assert_eq!(bar.matches('[').count(), 1, "a carriage return must never introduce a new stamp");
        assert!(!bar_start, "an unterminated line leaves the next chunk mid-line");
    }

    /// A chunk that splits a line mid-way stamps once, not twice.
    #[test]
    fn stamping_resumes_a_split_line_without_restamping() {
        let mut at_line_start = true;
        let first = String::from_utf8(stamp_lines(b"partial", &mut at_line_start)).expect("utf8");
        let second = String::from_utf8(stamp_lines(b" rest\n", &mut at_line_start)).expect("utf8");
        assert_eq!(first.matches('[').count(), 1);
        assert_eq!(second.matches('[').count(), 0);
        assert!(at_line_start);
    }
}
