#!/usr/bin/env node
/*
 * log-cap-writer.cjs — a tiny stdin→file pump that enforces a hard on-disk size
 * cap for a service's log. Each managed service pipes its combined stdout/stderr
 * through this process (see batchWriter.ts), so this process is the SOLE writer
 * of the log file and can safely trim it in place — the manager itself cannot,
 * because the shell holds the file with an exclusive-write lock.
 *
 * When the file grows past MAX_BYTES it is rewritten to keep only the most-recent
 * KEEP_BYTES, prefixed with a truncation marker. This guarantees a runaway log
 * (e.g. a chatty proxy under a bot-scan flood) never fills the disk nor exceeds
 * Node's max string length, which previously crashed the whole services API.
 *
 * Usage: node log-cap-writer.cjs <logFile> [maxBytes] [keepBytes]
 */
const fs = require('fs')

const logFile = process.argv[2]
const MAX_BYTES = parseInt(process.argv[3], 10) || 20 * 1024 * 1024
const KEEP_BYTES = parseInt(process.argv[4], 10) || 10 * 1024 * 1024

if (!logFile) {
  process.stderr.write('log-cap-writer: missing <logFile> argument\n')
  process.exit(2)
}

let fd = fs.openSync(logFile, 'a')
let size = safeSize()

/** Returns the current size of the open log file, or 0 if it can't be stat'd. */
function safeSize() {
  try {
    return fs.fstatSync(fd).size
  } catch {
    return 0
  }
}

/**
 * Trims the log to its most-recent KEEP_BYTES when it exceeds MAX_BYTES. Safe
 * because this process owns the only write handle: it closes, rewrites the file
 * with a marker + tail, then reopens for append.
 */
function trimIfNeeded() {
  if (size <= MAX_BYTES) return
  try {
    fs.closeSync(fd)
    const stat = fs.statSync(logFile)
    const start = Math.max(0, stat.size - KEEP_BYTES)
    const len = stat.size - start
    const buf = Buffer.alloc(len)
    const rfd = fs.openSync(logFile, 'r')
    fs.readSync(rfd, buf, 0, len, start)
    fs.closeSync(rfd)
    const marker = Buffer.from(
      `\n... [log-cap-writer: trimmed to last ${Math.round(KEEP_BYTES / 1048576)}MB — cap ${Math.round(MAX_BYTES / 1048576)}MB] ...\n`
    )
    fs.writeFileSync(logFile, Buffer.concat([marker, buf]))
  } catch {
    // best-effort — never let trimming break the service's output pump
  }
  fd = fs.openSync(logFile, 'a')
  size = safeSize()
}

const NEWLINE = 0x0a
/** True when the next byte written starts a fresh line and therefore wants a timestamp. */
let atLineStart = true

/**
 * Prefixes each NEWLINE-started line with an ISO timestamp.
 *
 * Added for ai-service task-1533: a ComfyUI render died mid-generation and the only place a traceback
 * could have landed was this file — which had no timestamps, so the exception could not be tied to the
 * render that hung. An undateable log is the difference between knowing and guessing.
 *
 * It stamps on \n ONLY, never on \r. Progress bars (tqdm, and anything else that redraws a line) emit
 * many carriage-returned updates per second; stamping those would multiply the file size, blow through
 * the cap, and turn one readable progress line into hundreds. Tracebacks and ordinary log output are
 * newline-delimited, so they get dated and the redrawing bars are left exactly as they were.
 *
 * Works on the Buffer rather than a decoded string so a service emitting non-UTF-8 bytes cannot be
 * corrupted by a round-trip through JavaScript strings.
 * @param chunk - the raw bytes read from the service's stdout/stderr
 */
function stampLines(chunk) {
  if (!chunk.length) return chunk
  const prefix = Buffer.from(`[${new Date().toISOString()}] `)
  const parts = []
  let start = 0
  if (atLineStart) { parts.push(prefix); atLineStart = false }
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] !== NEWLINE) continue
    parts.push(chunk.subarray(start, i + 1))
    start = i + 1
    if (start < chunk.length) parts.push(prefix)
    else atLineStart = true
  }
  if (start < chunk.length) parts.push(chunk.subarray(start))
  return Buffer.concat(parts)
}

process.stdin.on('data', (chunk) => {
  try {
    const stamped = stampLines(chunk)
    fs.writeSync(fd, stamped)
    size += stamped.length
  } catch {
    // ignore transient write failures; keep pumping
  }
  trimIfNeeded()
})

process.stdin.on('end', () => {
  try { fs.closeSync(fd) } catch { /* already closed */ }
  process.exit(0)
})

process.stdin.on('error', () => {
  // pipe closed abruptly (service killed) — exit cleanly
  try { fs.closeSync(fd) } catch { /* already closed */ }
  process.exit(0)
})
