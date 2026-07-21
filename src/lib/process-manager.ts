import { ChildProcess, spawn } from 'child_process'
import fs from 'fs'
import { EventEmitter } from 'events'
import { writeStartupScript } from '@/lib/util/batchWriter'
import { logTailer, getLogFilePath } from '@/lib/util/logTailer'
import { killWslPids } from '@/lib/util/portHelper'
import { setTrackedPidsProvider, snapshotProcessTable, buildProtectedPids } from '@/lib/util/processGuard'
import { onShutdown, fireAllSync } from '@/lib/lifecycle'

const treeKill = require('tree-kill')

// Environment variables that must never be inherited by a spawned service.
// `NoDefaultCurrentDirectoryInExePath` is set by some agent/terminal shells; when
// Service Manager inherits it, every service batch script loses cmd.exe's default
// "look in the current directory" behaviour, so `cd /d <dir>` + `app.exe` fails
// with "not recognized as an internal or external command". Whether a service
// starts must not depend on which shell Service Manager itself was launched from.
const STRIPPED_ENV_VARS = ['NoDefaultCurrentDirectoryInExePath']

/**
 * Builds the environment a spawned service inherits: the manager's own env minus
 * variables that would change how the service's startup script behaves.
 */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of STRIPPED_ENV_VARS) {
    for (const actual of Object.keys(env)) {
      if (actual.toLowerCase() === key.toLowerCase()) delete env[actual]
    }
  }
  return env
}

export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'error'
export type AdoptionKind = 'windows' | 'wsl'

export interface ServiceProcess {
  id: string
  process: ChildProcess | null
  status: ServiceStatus
  pid?: number
  startTime?: Date
  error?: string
  adoption?: AdoptionKind
}

export interface HealthResult {
  healthy: boolean
  reason?: string
}

const globalForProcessManager = globalThis as unknown as {
  processManagerInstance: ProcessManager | undefined
  smBootStarted: boolean | undefined
}

class ProcessManager extends EventEmitter {
  private processes: Map<string, ServiceProcess> = new Map()

  // The cmd.exe/powershell wrapper PID Service Manager spawned per service.
  // Deliberately NOT stored on the ServiceProcess entry: the reconciler replaces
  // that entry via adoptExternal() (process: null), which used to make SM forget
  // the wrapper it owns. The next start then only killed the adopted listener and
  // orphaned the wrapper, accumulating duplicate service instances (task-609).
  private spawnedWrappers: Map<string, number> = new Map()

  static getInstance(): ProcessManager {
    const existing = globalForProcessManager.processManagerInstance
    // Replace a stale singleton after a hot-reload: the existing instance was
    // created from the OLD class definition, so `instanceof ProcessManager`
    // (the NEW class) is false, reliably detecting stale instances regardless
    // of which methods changed.
    if (!existing || !(existing instanceof ProcessManager)) {
      if (existing) {
        // Fire sync cleanup on the old instance before replacing it
        try { (existing as any).hmrCleanup?.() } catch { /* best-effort */ }
        fireAllSync()
      }
      globalForProcessManager.processManagerInstance = new ProcessManager()
      // Reset the init promise so adoption re-runs with the fresh instance.
      ;(globalThis as any).smInitPromise = undefined
    }
    return globalForProcessManager.processManagerInstance!
  }

  constructor() {
    super()
    // Kill spawned children (not adopted) when the process exits cleanly
    onShutdown('process-manager:kill-spawned', () => {
      for (const proc of this.processes.values()) {
        if (proc.process && proc.pid && proc.status === 'running') {
          try { treeKill(proc.pid, 'SIGKILL') } catch { /* best-effort */ }
        }
      }
    })
    onShutdown('process-manager:stop-tailers', () => {
      logTailer.stopAll()
    })
    // Lets portHelper's kill guard see which PIDs belong to which service without
    // importing the process manager (portHelper is a dependency of this module).
    setTrackedPidsProvider(() => this.getTrackedPidsByService())
  }

  /**
   * Returns every PID Service Manager associates with each service — the tracked
   * process PID and the spawned wrapper PID. Used to build the never-kill set so
   * freeing one service's port can never kill another service's process.
   */
  getTrackedPidsByService(): Map<string, number[]> {
    const result = new Map<string, number[]>()
    for (const [id, proc] of this.processes) {
      const pids: number[] = []
      if (proc.pid) pids.push(proc.pid)
      if (proc.process?.pid) pids.push(proc.process.pid)
      if (pids.length > 0) result.set(id, pids)
    }
    for (const [id, wrapperPid] of this.spawnedWrappers) {
      const pids = result.get(id) ?? []
      if (!pids.includes(wrapperPid)) pids.push(wrapperPid)
      result.set(id, pids)
    }
    return result
  }

  /**
   * Returns the PIDs Service Manager itself spawned for a service. Only these may
   * be tree-killed (`taskkill /T`) when freeing the service's port.
   * @param serviceId - service to query
   */
  getSpawnedPids(serviceId: string): number[] {
    const pids: number[] = []
    const wrapper = this.spawnedWrappers.get(serviceId)
    if (wrapper) pids.push(wrapper)
    const child = this.processes.get(serviceId)?.process?.pid
    if (child && !pids.includes(child)) pids.push(child)
    return pids
  }

  /**
   * Tree-kills a wrapper process left over from a previous start of this service,
   * if it is still alive. Without this, a service whose entry was replaced by
   * adoption gets a second wrapper on every start and the old one keeps running.
   * @param serviceId - service whose stale wrapper should be reaped
   */
  /**
   * Finds and tree-kills EVERY wrapper process still running for this service,
   * not just the one in the in-memory registry. Wrappers are identified by the
   * unique `service-<serviceId>` startup-script path in their command line, so
   * this also reaps wrappers orphaned by an earlier Service Manager process —
   * the reason Dynamic DNS Updater accumulated four live instances.
   * Best-effort: if the process table can't be read, only the registry entry is used.
   * @param serviceId - service whose wrapper processes should be reaped
   */
  private async reapWrapperProcesses(serviceId: string): Promise<void> {
    this.reapStaleWrapper(serviceId)

    const table = await snapshotProcessTable()
    if (table.commandLineByPid.size === 0) return

    const protectedPids = buildProtectedPids({
      selfPid: process.pid,
      table,
      trackedPidsByServiceId: this.getTrackedPidsByService(),
      ownerServiceId: serviceId,
    })
    const marker = `service-${serviceId}`.toLowerCase()

    for (const [pid, commandLine] of table.commandLineByPid) {
      if (!commandLine.toLowerCase().includes(marker)) continue
      if (protectedPids.has(pid)) continue
      console.log(`[process-manager] reaping stale wrapper pid=${pid} for ${serviceId}`)
      try { treeKill(pid, 'SIGKILL') } catch { /* best-effort */ }
    }
  }

  reapStaleWrapper(serviceId: string): void {
    const wrapperPid = this.spawnedWrappers.get(serviceId)
    if (!wrapperPid) return
    this.spawnedWrappers.delete(serviceId)
    if (!this.isProcessRunning(wrapperPid)) return
    console.log(`[process-manager] reaping orphaned wrapper pid=${wrapperPid} for ${serviceId}`)
    try { treeKill(wrapperPid, 'SIGKILL') } catch { /* best-effort */ }
  }

  /**
   * Called by hot-reload singleton replacement to hand off state cleanly.
   * Does NOT kill spawned processes — they keep running and are re-adopted by
   * adoptRunningServices() on the next init cycle. Killing here would stop
   * Syllogi, AI Service, etc. every time a source file is saved in dev mode.
   */
  hmrCleanup(): void {
    logTailer.stopAll()
    this.processes.clear()
  }

  /** Survives HMR — stored on globalThis so a new instance doesn't re-trigger autostart. */
  hasBootStarted(): boolean {
    return globalForProcessManager.smBootStarted === true
  }

  markBootStarted(): void {
    globalForProcessManager.smBootStarted = true
  }

  getStatus(serviceId: string): ServiceProcess | undefined {
    return this.processes.get(serviceId)
  }

  getAllStatuses(): Map<string, ServiceProcess> {
    return this.processes
  }

  /**
   * Adopts a noPort service that has no OS port to match, using log-file freshness
   * as the signal that it is still running. No PID is tracked; the reconciler skips
   * port checks and PID checks for this service, keeping it healthy indefinitely.
   * @param serviceId - service to adopt
   */
  adoptNoPort(serviceId: string): void {
    const logFile = getLogFilePath(serviceId)
    console.log(`[process-manager] adoptNoPort ${serviceId}`)

    logTailer.start(serviceId, logFile, true)

    this.processes.set(serviceId, {
      id: serviceId,
      process: null,
      status: 'running',
      pid: undefined,
      adoption: 'windows',
    })
    this.emit('status-change', serviceId, 'running')
  }

  /**
   * Adopts an externally-running process (found via port scan) so service-manager
   * tracks it as running and tails its log file for new output.
   * @param serviceId - service to adopt
   * @param pid - the OS-level PID listening on the service's port
   * @param kind - 'windows' or 'wsl' determines which kill path to use
   */
  adoptExternal(serviceId: string, pid: number, kind: AdoptionKind): void {
    const logFile = getLogFilePath(serviceId)
    console.log(`[process-manager] adoptExternal ${serviceId} pid=${pid} kind=${kind}`)

    logTailer.start(serviceId, logFile, true) // fromStart:true — load recent history so terminal isn't blank

    this.processes.set(serviceId, {
      id: serviceId,
      process: null,
      status: 'running',
      pid,
      adoption: kind,
    })
    this.emit('status-change', serviceId, 'running')
  }

  /**
   * Checks if a process with the given PID is alive (Windows only).
   * @param pid - Windows PID to probe
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (err: any) {
      // EPERM means the process exists but we don't have permission to signal it — still alive
      if (err.code === 'EPERM') return true
      return false
    }
  }

  /**
   * Verifies a service is truly healthy using pre-fetched OS port snapshots.
   * Returns healthy=false if PID is dead, port is not bound, or port is bound by a different PID.
   * @param serviceId - service to verify
   * @param port - the configured port for the service (null = skip port check)
   * @param winMap - pre-fetched Windows listener map (port → pids)
   * @param wslMap - pre-fetched WSL listener map (port → pids)
   */
  verifyHealthWithMaps(
    serviceId: string,
    port: number | null,
    winMap: Map<number, number[]>,
    wslMap: Map<number, number[]>
  ): HealthResult {
    const proc = this.processes.get(serviceId)
    if (!proc || proc.status !== 'running') return { healthy: false, reason: 'not-running' }

    // Spawned children: trust process exit event; also verify PID alive
    if (proc.process) {
      if (proc.process.exitCode !== null || proc.process.killed) {
        return { healthy: false, reason: 'process-exited' }
      }
      return { healthy: true }
    }

    // Adopted PIDs: check PID alive
    if (proc.pid) {
      if (proc.adoption !== 'wsl' && !this.isProcessRunning(proc.pid)) {
        return { healthy: false, reason: 'pid-dead' }
      }
    }

    // Port binding check (only if port is configured)
    if (!port) return { healthy: true }

    const map = proc.adoption === 'wsl' ? wslMap : winMap
    const pids = map.get(port)
    if (!pids || pids.length === 0) return { healthy: false, reason: 'port-not-bound' }
    if (proc.pid && !pids.includes(proc.pid)) {
      return { healthy: false, reason: 'port-taken-by-other-pid' }
    }

    return { healthy: true }
  }

  /**
   * Marks a service as unhealthy (stopped) without trying to kill it.
   * Used by the reconciler when a health probe reveals the process is gone.
   * @param serviceId - service to mark
   * @param reason - reason for the status change (logged to console)
   */
  markUnhealthy(serviceId: string, reason: string): void {
    const proc = this.processes.get(serviceId)
    console.log(`[process-manager] ${serviceId} marked unhealthy: ${reason}`)
    if (proc) {
      proc.status = 'stopped'
      proc.process = null
      proc.pid = undefined
      proc.adoption = undefined
      proc.error = reason
    }
    this.emit('status-change', serviceId, 'stopped')
  }

  /**
   * Spawns a new process for the service, redirecting output to a log file.
   * If the service is already running it is stopped first.
   * @param serviceId - service to start
   * @param command - shell command to execute
   * @param env - additional environment variables
   * @param onStateChange - callback invoked on every status transition
   */
  async startService(
    serviceId: string,
    command: string,
    env: Record<string, string> = {},
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    const existing = this.processes.get(serviceId)
    // Covers both spawned (process !== null) and adopted (process === null) running states.
    // Also cleans up errored spawned processes so orphaned webpack/nest workers are tree-killed
    // rather than left alive and accumulating on each failed start attempt.
    if (existing?.status === 'running' || (existing?.process && existing.status === 'error')) {
      await this.stopService(serviceId, onStateChange)
    }
    // Reap any wrapper left behind by an earlier start (or an earlier Service
    // Manager process) — otherwise this spawn produces a duplicate instance.
    await this.reapWrapperProcesses(serviceId)

    const { scriptFile, logFile } = writeStartupScript(serviceId, command, env)
    const isPowerShell = scriptFile.endsWith('.ps1')

    // Truncate the log file before spawning so logTailer.start sees an empty file
    // (offset=0). Without this, the tailer reads the old file size as its offset;
    // when the batch script then truncates the file, new output is permanently missed.
    try { fs.writeFileSync(logFile, '') } catch { /* dir may not exist yet */ }

    const serviceProcess: ServiceProcess = {
      id: serviceId,
      process: null,
      status: 'starting',
      startTime: new Date(),
    }

    this.processes.set(serviceId, serviceProcess)
    this.emit('status-change', serviceId, 'starting')
    if (onStateChange) await onStateChange('starting', undefined)

    try {
      const spawnCmd = isPowerShell ? 'powershell.exe' : 'cmd.exe'
      const spawnArgs = isPowerShell
        ? ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', scriptFile]
        : ['/c', scriptFile]

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        env: buildSpawnEnv(),
      })

      serviceProcess.process = child
      serviceProcess.pid = child.pid
      if (child.pid) this.spawnedWrappers.set(serviceId, child.pid)
      serviceProcess.status = 'running'
      this.emit('status-change', serviceId, 'running')
      if (onStateChange) await onStateChange('running', child.pid)

      // Output is captured via the log file; start tailing from the beginning of this run
      logTailer.start(serviceId, logFile, true)

      child.on('exit', async (code) => {
        if (this.spawnedWrappers.get(serviceId) === child.pid) this.spawnedWrappers.delete(serviceId)
        const proc = this.processes.get(serviceId)
        if (proc) {
          proc.status = code === 0 ? 'stopped' : 'error'
          proc.process = null
          proc.pid = undefined
          if (code !== 0) proc.error = `Process exited with code ${code}`
          this.emit('status-change', serviceId, proc.status, code)
          if (onStateChange) await onStateChange(proc.status, undefined)
        }
        // Do NOT stop the tailer here — keep the buffer so the user can read the
        // last output after the process exits or crashes. The tailer is cleared the
        // next time startService is called for this service.
      })

      child.on('error', async (err) => {
        const proc = this.processes.get(serviceId)
        if (proc) {
          proc.status = 'error'
          proc.error = err.message
          proc.process = null
          proc.pid = undefined
          this.emit('status-change', serviceId, 'error')
          if (onStateChange) await onStateChange('error', undefined)
        }
        // Keep the buffer for post-mortem inspection.
      })
    } catch (error: any) {
      serviceProcess.status = 'error'
      serviceProcess.error = error.message
      this.emit('status-change', serviceId, 'error')
      if (onStateChange) await onStateChange('error', undefined)
      throw error
    }
  }

  /**
   * Stops a running service. Uses wsl kill for WSL-adopted processes,
   * tree-kill for Windows-spawned and Windows-adopted processes.
   * @param serviceId - service to stop
   * @param onStateChange - callback invoked on status transition
   */
  async stopService(
    serviceId: string,
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    const serviceProcess = this.processes.get(serviceId)
    const pid = serviceProcess?.process?.pid ?? serviceProcess?.pid

    if (!pid) {
      if (serviceProcess) {
        serviceProcess.status = 'stopped'
        serviceProcess.pid = undefined
      }
      this.emit('status-change', serviceId, 'stopped')
      if (onStateChange) await onStateChange('stopped', undefined)
      return
    }

    // WSL-adopted processes must be killed via `wsl kill -9`, not tree-kill
    if (serviceProcess?.adoption === 'wsl') {
      await killWslPids([pid])
      this.reapStaleWrapper(serviceId)
      if (serviceProcess) {
        serviceProcess.status = 'stopped'
        serviceProcess.process = null
        serviceProcess.pid = undefined
        serviceProcess.adoption = undefined
      }
      this.emit('status-change', serviceId, 'stopped')
      if (onStateChange) await onStateChange('stopped', undefined)
      return
    }

    return new Promise((resolve) => {
      treeKill(pid, 'SIGTERM', async (err: Error | null) => {
        if (err) {
          treeKill(pid, 'SIGKILL', async () => {
            await this.markStopped(serviceId, serviceProcess, onStateChange)
            resolve()
          })
        } else {
          await this.markStopped(serviceId, serviceProcess, onStateChange)
          resolve()
        }
      })

      setTimeout(async () => {
        if (serviceProcess && serviceProcess.status !== 'stopped') {
          await this.markStopped(serviceId, serviceProcess, onStateChange)
          resolve()
        }
      }, 5000)
    })
  }

  async markStopped(
    serviceId: string,
    serviceProcess: ServiceProcess | undefined,
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    // A wrapper we spawned may outlive the PID we just killed (adoption replaces
    // the tracked PID with the listener's). Reap it so nothing is left running.
    this.reapStaleWrapper(serviceId)
    if (serviceProcess) {
      serviceProcess.status = 'stopped'
      serviceProcess.process = null
      serviceProcess.pid = undefined
      serviceProcess.adoption = undefined
    }
    this.emit('status-change', serviceId, 'stopped')
    if (onStateChange) await onStateChange('stopped', undefined)
    // Buffer is preserved so the user can still read the last output after stopping.
    // It is cleared the next time startService is called.
  }

  /**
   * Stops then starts a service with the given command and env.
   * @param serviceId - service to restart
   * @param command - shell command to execute
   * @param env - additional environment variables
   * @param onStateChange - callback invoked on every status transition
   */
  async restartService(
    serviceId: string,
    command: string,
    env: Record<string, string> = {},
    onStateChange?: (status: ServiceStatus, pid?: number) => Promise<void>
  ): Promise<void> {
    await this.stopService(serviceId, onStateChange)
    await new Promise(resolve => setTimeout(resolve, 500))
    await this.startService(serviceId, command, env, onStateChange)
  }

  /**
   * Returns recent log lines for a service from the log tailer's ring buffer.
   * @param serviceId - service to get output for
   */
  getOutput(serviceId: string): string[] {
    return logTailer.getRecent(serviceId)
  }

  /**
   * Clears the in-memory log buffer for a service without stopping the tailer.
   * @param serviceId - service to clear output for
   */
  clearOutput(serviceId: string): void {
    logTailer.clearBuffer(serviceId)
    this.emit('output-cleared', serviceId)
  }

  /**
   * Returns true if the service has a running process.
   * For adopted processes the port scan is already proof enough — no re-probe.
   * For spawned Windows processes the PID is probed to catch silent exits.
   * @param serviceId - service to check
   */
  isRunning(serviceId: string): boolean {
    const proc = this.processes.get(serviceId)
    if (proc?.status !== 'running') return false

    // Spawned children: trust process exit event for liveness
    if (proc.process) return proc.process.exitCode === null && !proc.process.killed

    // WSL PIDs cannot be probed from Windows — skip the check entirely.
    if (proc.adoption === 'wsl') return true

    // For adopted Windows processes, verify the PID is still alive
    if (proc.pid && !this.isProcessRunning(proc.pid)) {
      proc.status = 'stopped'
      proc.pid = undefined
      return false
    }
    return true
  }

  /**
   * Returns the current PID for a service, if known.
   * @param serviceId - service to query
   */
  getPid(serviceId: string): number | undefined {
    return this.processes.get(serviceId)?.pid
  }
}

export const processManager = ProcessManager.getInstance()
