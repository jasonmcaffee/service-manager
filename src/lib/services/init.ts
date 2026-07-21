import fs from 'fs'
import { processManager, ServiceStatus } from '@/lib/process-manager'
import { runProfileRepository } from '@/lib/repositories/runProfileRepository'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import {
  snapshotWindowsListeners, snapshotWslListeners, isWslProxyPid,
  killPort, killMatchingProcesses, extractServiceDir, ensureWslPortProxy,
} from '@/lib/util/portHelper'
import { getLogFilePath } from '@/lib/util/logTailer'
import { reconciler } from '@/lib/services/reconciler'

const globalForInit = globalThis as unknown as { smInitPromise?: Promise<void> }

/**
 * Known port defaults for services that don't store a port in the DB.
 * Only applied when the service's port is currently NULL.
 */
const KNOWN_PORT_DEFAULTS: Record<string, number> = {
  'Speaches STT & TTS': 8000,
}

/**
 * Creates the Default profile and migrates any legacy cudaDevice/startOnBoot
 * columns if no profiles exist yet.
 */
export async function ensureDefaultProfile(): Promise<void> {
  const count = await runProfileRepository.count()
  if (count > 0) return

  const profile = await runProfileRepository.create('Default')
  await runProfileRepository.setActive(profile.id)

  const services = await serviceRepository.findAll()
  for (const service of services) {
    await runProfileRepository.upsertProfileService(profile.id, service.id, {
      cudaDevice: (service as any).cudaDevice ?? null,
      startOnBoot: (service as any).startOnBoot ?? false,
    })
  }
}

/**
 * Backfills known port defaults for services with port=NULL.
 * Only runs when the port is actually NULL so user overrides are preserved.
 */
async function backfillKnownPorts(): Promise<void> {
  for (const [name, port] of Object.entries(KNOWN_PORT_DEFAULTS)) {
    const svc = await serviceRepository.findByName(name)
    if (svc && svc.port == null) {
      await serviceRepository.update(svc.id, { port })
      console.log(`[init] backfilled port=${port} for "${name}"`)
    }
  }
}

/**
 * Returns services sorted so active-profile autostart services come first.
 * This ensures that when two services share a port, the intended one adopts.
 * @param services - all services from DB
 * @param activeProfileId - active profile id (undefined = no active profile)
 */
async function rankByAutostartPriority(services: any[], activeProfileId: string | undefined): Promise<any[]> {
  if (!activeProfileId) return services
  const autoStartEntries = await runProfileRepository.findAutoStartServices(activeProfileId)
  const autostartIds = new Set(autoStartEntries.map((e: any) => e.serviceId))
  return [...services].sort((a, b) => Number(autostartIds.has(b.id)) - Number(autostartIds.has(a.id)))
}

export interface AdoptionReport {
  adopted: Array<{ serviceId: string; pid: number; kind: string }>
  conflicts: Array<{ serviceId: string; port: number; pid: number }>
  skipped: Array<{ serviceId: string; reason: string }>
}

/**
 * Scans OS listeners once (Windows + WSL) and adopts any service whose port
 * is already occupied — preventing EADDRINUSE on service-manager restarts.
 * Uses claim-tracking to ensure one PID is never adopted by two services.
 * Retries the WSL/Windows snapshot once if it fails, so a slow first `wsl`
 * call doesn't leave WSL services unadopted at boot.
 */
async function adoptRunningServices(): Promise<AdoptionReport> {
  let [winMap, wslMap] = await Promise.all([
    snapshotWindowsListeners(),
    snapshotWslListeners(),
  ])

  // Retry once if either snapshot failed — `wsl` can be slow to wake on cold boot
  // and a single retry typically succeeds. Without this, vllm and other WSL
  // services aren't adopted and get incorrectly marked stopped.
  if (winMap === null || wslMap === null) {
    console.log('[init] snapshot returned null, retrying after 500ms (winMap=%s, wslMap=%s)', winMap !== null, wslMap !== null)
    await new Promise(r => setTimeout(r, 500))
    const [winRetry, wslRetry] = await Promise.all([
      winMap === null ? snapshotWindowsListeners() : Promise.resolve(winMap),
      wslMap === null ? snapshotWslListeners() : Promise.resolve(wslMap),
    ])
    winMap = winRetry
    wslMap = wslRetry
  }

  const services = await serviceRepository.findAll()
  const active = await runProfileRepository.findActive()
  const ranked = await rankByAutostartPriority(services, active?.id)

  const claimed = new Set<string>()
  const claimedPorts = new Set<number>()
  const report: AdoptionReport = { adopted: [], conflicts: [], skipped: [] }

  for (const svc of ranked) {
    if (!svc.port) {
      report.skipped.push({ serviceId: svc.id, reason: 'no-port' })
      continue
    }
    if (processManager.isRunning(svc.id)) continue

    // Skip services whose required snapshot is unavailable so we don't accidentally
    // treat "command failed" as "nothing listening" and trigger an unnecessary kill+restart.
    if ((svc as any).wsl && wslMap === null) {
      report.skipped.push({ serviceId: svc.id, reason: 'wsl-snapshot-failed' })
      console.warn(`[init] skipping adoption check for WSL service "${svc.name}" — wsl snapshot failed`)
      continue
    }
    if (!(svc as any).wsl && winMap === null && wslMap === null) {
      report.skipped.push({ serviceId: svc.id, reason: 'both-snapshots-failed' })
      continue
    }

    // Port-level claim: even if two services resolve to different PIDs/maps on
    // the same port (e.g. a WSL service and the Windows port-forwarding proxy),
    // only one service may hold a given port at a time.
    if (claimedPorts.has(svc.port)) {
      report.conflicts.push({ serviceId: svc.id, port: svc.port, pid: 0 })
      console.warn(`[init] adoption conflict: "${svc.name}" (port ${svc.port}) — port already claimed by another service`)
      continue
    }

    const rawWinPid = winMap?.get(svc.port)?.[0]
    const wslPid = wslMap?.get(svc.port)?.[0]

    // Filter out Windows PIDs that belong to svchost (WSL's port-forwarding proxy
    // via iphlpsvc). svchost stays on the port even when the WSL service has stopped,
    // so adopting it would keep the service falsely marked as running forever.
    const winPid = (rawWinPid !== undefined && await isWslProxyPid(rawWinPid))
      ? undefined
      : rawWinPid

    // WSL services: only adopt from the WSL process map.
    // The Windows port-forwarding proxy stays alive even when the WSL service has
    // stopped, so using it as the health signal gives a false positive.
    const candidate = (svc as any).wsl
      ? (wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid } : null)
      : winPid !== undefined ? { kind: 'windows' as const, pid: winPid }
        : wslPid !== undefined ? { kind: 'wsl' as const, pid: wslPid }
        : null

    if (!candidate) continue

    const key = `${candidate.kind}:${candidate.pid}`
    if (claimed.has(key)) {
      report.conflicts.push({ serviceId: svc.id, port: svc.port, pid: candidate.pid })
      console.warn(`[init] adoption conflict: "${svc.name}" (port ${svc.port}) — pid ${candidate.pid} already claimed by another service`)
      continue
    }
    claimed.add(key)
    claimedPorts.add(svc.port)

    processManager.adoptExternal(svc.id, candidate.pid, candidate.kind)
    await serviceRepository.update(svc.id, { status: 'running', pid: candidate.pid })
    report.adopted.push({ serviceId: svc.id, pid: candidate.pid, kind: candidate.kind })
    console.log(`[init] adopted "${svc.name}" (port ${svc.port}) pid=${candidate.pid} kind=${candidate.kind}`)
  }

  if (report.conflicts.length > 0) {
    console.warn(`[init] ${report.conflicts.length} port conflict(s) detected — check for services sharing the same port`)
  }

  return report
}

const LOG_FRESHNESS_MS = 30 * 60 * 1000 // 30 minutes

/**
 * For noPort services, uses log file freshness as the signal that the process is still
 * running. If the log file was written within LOG_FRESHNESS_MS, the service is adopted
 * without a PID — the logTailer watches the file so new output is captured.
 */
async function adoptNoPortServices(): Promise<void> {
  const services = await serviceRepository.findAll()

  for (const svc of services) {
    if (!(svc as any).noPort) continue
    if (processManager.isRunning(svc.id)) continue

    const logFile = getLogFilePath(svc.id)
    if (!fs.existsSync(logFile)) continue

    const stat = fs.statSync(logFile)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > LOG_FRESHNESS_MS) continue

    processManager.adoptNoPort(svc.id)
    await serviceRepository.update(svc.id, { status: 'running', pid: null })
    console.log(`[init] adopted noPort service "${svc.name}" via log freshness (age=${Math.round(ageMs / 1000)}s)`)
  }
}

export interface AutoStartResult {
  id: string
  name: string
  status: 'started' | 'already_running' | 'error'
  error?: string
}

// Delays (ms after the first autostart pass) at which failed start-on-boot
// services are re-attempted. On a cold boot a GPU service (llama.cpp) can fail
// its very first launch because the NVIDIA driver / second GPU isn't ready yet,
// and a plain start-on-boot has no retry so it stays dead until a manual Start.
// These sweeps re-run the idempotent autostart for any flagged service still not
// running. They're bounded to the first few minutes after boot so a service the
// user deliberately stops later is never resurrected.
const AUTOSTART_RETRY_DELAYS_MS = [30_000, 90_000, 180_000]

const globalForAutostartRetry = globalThis as unknown as { smAutostartRetriesScheduled?: boolean }

/**
 * Builds a state-change callback that persists a service's status/pid to the DB
 * as the process manager transitions it through starting/running/stopped.
 * @param id - service id whose row is updated
 */
function makeOnStateChange(id: string) {
  return async (status: ServiceStatus, pid?: number) => {
    await serviceRepository.update(id, { status, pid: pid ?? null })
  }
}

/**
 * Starts a single start-on-boot service unless it is already running/adopted.
 * Mirrors the manual-start path: frees the port, spawns via the process manager,
 * and (for WSL services) re-establishes the Windows port proxy. Skipping already
 * running services keeps this idempotent so a service adopted at boot is never
 * double-started.
 * @param entry - RunProfileService row joined with its service and cudaDevice
 */
async function startOneAutoStartService(entry: any): Promise<AutoStartResult> {
  const service = entry.service
  if (processManager.isRunning(service.id)) {
    console.log(`[init] autostart skip "${service.name}" — already running/adopted`)
    return { id: service.id, name: service.name, status: 'already_running' }
  }
  try {
    const env: Record<string, string> = {}
    if (service.port) env.PORT = String(service.port)
    if (entry.cudaDevice) env.CUDA_DEVICE = entry.cudaDevice
    if (service.port) {
      if (!service.wsl) {
        const dir = extractServiceDir(service.command)
        if (dir) await killMatchingProcesses(dir, 'node_modules', service.id)
      }
      await killPort(service.port, {
        ownerServiceId: service.id,
        spawnedPids: processManager.getSpawnedPids(service.id),
      })
    }
    console.log(`[init] autostart starting "${service.name}"`)
    await processManager.startService(service.id, service.command, env, makeOnStateChange(service.id))
    if (service.wsl && service.port) await ensureWslPortProxy(service.port)
    return { id: service.id, name: service.name, status: 'started' }
  } catch (error: any) {
    console.error(`[init] autostart error "${service.name}": ${error.message}`)
    return { id: service.id, name: service.name, status: 'error', error: error.message }
  }
}

/**
 * Starts every start-on-boot service in the active profile that is not already
 * running or adopted. This is the server-side autostart that runs when the
 * manager process boots, so flagged services launch even when no browser ever
 * opens the UI. Idempotent — running/adopted services are skipped so nothing
 * listening on its port is double-started. Entries are processed sequentially
 * with a brief settle delay after each real spawn.
 */
export async function startAutoStartServices(): Promise<AutoStartResult[]> {
  const active = await runProfileRepository.findActive()
  if (!active) {
    console.log('[init] autostart: no active profile — nothing to start')
    return []
  }
  const entries = await runProfileRepository.findAutoStartServices(active.id)
  const results: AutoStartResult[] = []
  for (const entry of entries) {
    const result = await startOneAutoStartService(entry)
    results.push(result)
    if (result.status === 'started') await new Promise(r => setTimeout(r, 1000))
  }
  const started = results.filter(r => r.status === 'started').length
  const running = results.filter(r => r.status === 'already_running').length
  const errored = results.filter(r => r.status === 'error').length
  console.log(`[init] autostart complete: ${started} started, ${running} already running, ${errored} errored`)
  scheduleAutoStartRetries()
  return results
}

/**
 * Re-attempts every start-on-boot service in the active profile that is not
 * currently running. Reuses the idempotent startOneAutoStartService, which skips
 * services already up/adopted, so only genuinely-failed services are (re)started.
 * A single sweep pass — invoked on a timer by scheduleAutoStartRetries.
 * @param attempt - 1-based sweep number, for logging
 */
export async function retryFailedAutoStartServices(attempt: number): Promise<void> {
  const active = await runProfileRepository.findActive()
  if (!active) return
  const entries = await runProfileRepository.findAutoStartServices(active.id)
  const down = entries.filter((e: any) => !processManager.isRunning(e.service.id))
  if (down.length === 0) {
    console.log(`[init] autostart retry #${attempt}: all start-on-boot services running`)
    return
  }
  console.log(`[init] autostart retry #${attempt}: re-attempting ${down.length} down service(s): ${down.map((e: any) => e.service.name).join(', ')}`)
  for (const entry of down) {
    const result = await startOneAutoStartService(entry)
    if (result.status === 'started') await new Promise(r => setTimeout(r, 1000))
  }
}

/**
 * Schedules the delayed retry sweeps (once per manager boot) that self-heal
 * start-on-boot services which failed their first launch — most notably the
 * GPU-backed llama.cpp server after a cold reboot when the driver wasn't ready.
 * Guarded on globalThis so HMR / repeated init calls don't stack timers.
 */
function scheduleAutoStartRetries(): void {
  if (globalForAutostartRetry.smAutostartRetriesScheduled) return
  globalForAutostartRetry.smAutostartRetriesScheduled = true
  AUTOSTART_RETRY_DELAYS_MS.forEach((delay, i) => {
    setTimeout(() => {
      retryFailedAutoStartServices(i + 1).catch(err =>
        console.error(`[init] autostart retry #${i + 1} failed:`, err.message)
      )
    }, delay).unref?.()
  })
}

/**
 * Single-flight initialization: backfills ports, ensures a default profile exists,
 * adopts already-running services, starts any start-on-boot service that adoption
 * didn't already pick up, then starts the reconciler.
 * Safe to call concurrently — all callers share the same Promise.
 */
export function initializeIfNeeded(): Promise<void> {
  if (!globalForInit.smInitPromise) {
    globalForInit.smInitPromise = (async () => {
      await backfillKnownPorts()
      await ensureDefaultProfile()
      await adoptRunningServices()
      await adoptNoPortServices()
      // Launch flagged-but-stopped services. The boot guard is shared (via the
      // process manager on globalThis) with the HTTP /startup path, so whichever
      // trigger fires first wins and services are never double-started.
      if (!processManager.hasBootStarted()) {
        processManager.markBootStarted()
        await startAutoStartServices()
      }
      reconciler.start()
    })()
  }
  return globalForInit.smInitPromise
}
