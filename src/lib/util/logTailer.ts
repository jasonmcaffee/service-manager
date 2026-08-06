import fs from 'fs'
import path from 'path'
import os from 'os'

const MAX_LINES = 1000
const POLL_INTERVAL_MS = 150

// Hard cap for on-disk service logs. A runaway log (e.g. a chatty proxy under a
// bot-scan flood) must never exceed this — reading a file larger than Node's max
// string length (~512MB) throws and previously 500'd the entire /api/services
// endpoint, blanking the UI. See log-cap-writer.cjs for the write-side enforcement.
export const MAX_LOG_BYTES = 20 * 1024 * 1024

// Only this much of an existing log is read when a tailer starts. The buffer keeps
// MAX_LINES (1000) lines, so pulling the whole 20 MB cap into a string on every
// (re-)adoption was pure waste — and on a pre-cap oversized file it threw
// ERR_STRING_TOO_LONG, which aborted the entire reconciler tick (task-609).
export const INITIAL_TAIL_BYTES = 512 * 1024

export function getLogFilePath(serviceId: string): string {
  const logsDir = path.join(os.tmpdir(), 'service-manager', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  return path.join(logsDir, `service-${serviceId}.log`)
}

/**
 * Reads a log file as a string while never loading more than MAX_LOG_BYTES.
 * When the file is larger than the cap, only its most-recent MAX_LOG_BYTES are
 * returned so a giant file can never exceed Node's max string length and crash.
 * @param logFile - absolute path to the log file
 * @param maxBytes - most-recent bytes to read (defaults to the on-disk cap)
 */
export function readLogFileCapped(logFile: string, maxBytes: number = MAX_LOG_BYTES): string {
  const size = fs.statSync(logFile).size
  if (size <= maxBytes) return fs.readFileSync(logFile, 'utf-8')
  const buf = Buffer.alloc(maxBytes)
  const fd = fs.openSync(logFile, 'r')
  try {
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes)
  } finally {
    fs.closeSync(fd)
  }
  return buf.toString('utf-8')
}

/**
 * Appends a Service-Manager-authored line to a service's own log file so decisions
 * the manager made ABOUT the service are visible in the place someone actually
 * looks — the service's terminal output.
 *
 * Without this, a start the VRAM guard refused, a stop a profile switch performed,
 * and a service the reconciler found dead all presented identically: the card just
 * said "stopped" and /output still showed the previous run's tail, with the real
 * reason living only in the Service Manager console (task-1493).
 *
 * Best-effort by design — a failed note must never break a start/stop path. The
 * running tailer picks the line up on its next poll, and the file fallback serves
 * it for services with no live tailer.
 * @param serviceId - service whose log should carry the note
 * @param message - the reason, written verbatim after the marker
 */
export function appendServiceNote(serviceId: string, message: string): void {
  try {
    const logFile = getLogFilePath(serviceId)
    const stamp = new Date().toISOString()
    const line = message
      .split('\n')
      .map(l => `[service-manager ${stamp}] ${l.trim()}`)
      .join('\n')
    fs.appendFileSync(logFile, `${line}\n`, 'utf-8')
  } catch (err: any) {
    console.warn(`[logTailer] could not append note for ${serviceId}:`, err?.message)
  }
}

interface TailerEntry {
  interval: ReturnType<typeof setInterval>
  offset: number
  buffer: string[]
}

const globalForLogTailer = globalThis as unknown as { logTailerInstance: LogTailer | undefined }

class LogTailer {
  private tailers = new Map<string, TailerEntry>()

  static getInstance(): LogTailer {
    const existing = globalForLogTailer.logTailerInstance
    // After a hot-reload the existing instance is not an instanceof the NEW class.
    // Stop all old intervals before replacing so we don't leak setInterval handles.
    if (!existing || !(existing instanceof LogTailer)) {
      if (existing) {
        for (const entry of (existing as any).tailers?.values?.() ?? []) {
          clearInterval(entry.interval)
        }
      }
      globalForLogTailer.logTailerInstance = new LogTailer()
    }
    return globalForLogTailer.logTailerInstance!
  }

  /**
   * Begins tailing a log file for a service. fromStart=true reads from byte 0;
   * fromStart=false seeks to current EOF and only picks up new writes.
   * @param serviceId - unique service id
   * @param logFile - absolute path to the log file
   * @param fromStart - whether to read existing file content
   */
  start(serviceId: string, logFile: string, fromStart: boolean): void {
    this.stop(serviceId)

    let offset = 0
    const buffer: string[] = []
    let partial = ''

    if (fs.existsSync(logFile)) {
      if (fromStart) {
        const content = readLogFileCapped(logFile, INITIAL_TAIL_BYTES)
        const lines = content.split('\n').filter(l => l.length > 0)
        buffer.push(...lines.slice(-MAX_LINES))
        // Seek to true EOF, not content byte-length: when the file exceeds the
        // cap we only loaded its tail, so the skipped head must not be re-read
        // by the poll loop (which would rebuild the same oversized string).
        offset = fs.statSync(logFile).size
      } else {
        offset = fs.statSync(logFile).size
      }
    }

    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(logFile)) return
        const stats = fs.statSync(logFile)

        // File was truncated (e.g. log rotation or script restart) — reset so new
        // content is captured from byte 0 instead of being silently skipped.
        if (stats.size < offset) {
          offset = 0
          buffer.length = 0
          partial = ''
        }

        if (stats.size <= offset) return

        const length = stats.size - offset
        const buf = Buffer.alloc(length)
        const fd = fs.openSync(logFile, 'r')
        fs.readSync(fd, buf, 0, length, offset)
        fs.closeSync(fd)
        offset = stats.size

        const text = partial + buf.toString('utf-8')
        const parts = text.split('\n')
        // last element is either empty string or an incomplete line
        partial = parts.pop() ?? ''
        const lines = parts.filter(l => l.length > 0)

        buffer.push(...lines)
        if (buffer.length > MAX_LINES) {
          buffer.splice(0, buffer.length - MAX_LINES)
        }
      } catch {
        // file may be locked or disappear transiently
      }
    }, POLL_INTERVAL_MS)

    this.tailers.set(serviceId, { interval, offset, buffer })
  }

  /**
   * Stops tailing a service's log file and clears the in-memory buffer.
   * @param serviceId - unique service id
   */
  stop(serviceId: string): void {
    const entry = this.tailers.get(serviceId)
    if (entry) {
      clearInterval(entry.interval)
      this.tailers.delete(serviceId)
    }
  }

  /**
   * Returns the in-memory ring buffer of recent log lines for a service.
   * @param serviceId - unique service id
   */
  getRecent(serviceId: string): string[] {
    return this.tailers.get(serviceId)?.buffer ?? []
  }

  /**
   * Clears the in-memory ring buffer without stopping the tailer.
   * @param serviceId - unique service id
   */
  clearBuffer(serviceId: string): void {
    const entry = this.tailers.get(serviceId)
    if (entry) entry.buffer.length = 0
  }

  /**
   * Stops all active tailers and clears state. Used on shutdown/hot-reload cleanup.
   */
  stopAll(): void {
    for (const [, entry] of this.tailers) {
      clearInterval(entry.interval)
    }
    this.tailers.clear()
  }
}

export const logTailer = LogTailer.getInstance()
