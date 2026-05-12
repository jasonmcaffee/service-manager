import fs from 'fs'
import path from 'path'
import os from 'os'

const MAX_LINES = 1000
const POLL_INTERVAL_MS = 150

export function getLogFilePath(serviceId: string): string {
  const logsDir = path.join(os.tmpdir(), 'service-manager', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  return path.join(logsDir, `service-${serviceId}.log`)
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
        const content = fs.readFileSync(logFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.length > 0)
        buffer.push(...lines.slice(-MAX_LINES))
        offset = Buffer.byteLength(content, 'utf-8')
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
