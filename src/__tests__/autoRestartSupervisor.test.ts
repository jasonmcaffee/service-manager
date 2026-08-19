/**
 * Unit tests for auto-restart (task-1593).
 *
 * The bug this guards against: jasonmcaffee.com and media.jasonmcaffee.com both went
 * down when their Next.js processes died, and stayed down for ~12 hours because
 * `startOnBoot` only ever fires when Service Manager boots and the reconciler was
 * observe-only. The supervisor's contract is narrow on purpose — it may only resurrect
 * a service that is BOTH opted in and wanted up, so a deliberate stop is never undone.
 */

const mockAppendServiceNote = jest.fn()
jest.mock('@/lib/util/logTailer', () => ({
  appendServiceNote: (...args: any[]) => mockAppendServiceNote.apply(null, args as any),
}))

const mockSetDesiredStatus = jest.fn(async () => undefined)
// considerRestart re-reads the row so a Stop issued mid-tick is never raced.
const mockFindById = jest.fn(async (_id: string): Promise<any> => ({ desiredStatus: 'running' }))
jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    setDesiredStatus: (...args: any[]) => mockSetDesiredStatus.apply(null, args as any),
    findById: (...args: any[]) => mockFindById.apply(null, args as any),
  },
}))

const mockFindActive = jest.fn(async () => ({ id: 'profile-1' }) as any)
const mockFindAutoRestartServices = jest.fn(async () => [] as any[])
jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: (...args: any[]) => mockFindActive.apply(null, args as any),
    findAutoRestartServices: (...args: any[]) => mockFindAutoRestartServices.apply(null, args as any),
  },
}))

import {
  considerRestart,
  loadAutoRestartServiceIds,
  noteServiceRunning,
  resetAutoRestartState,
} from '@/lib/services/autoRestartSupervisor'

const SITE = { id: 'svc-site', name: 'Jason McAffee Site', port: 3200, desiredStatus: 'running' }

/** Runs considerRestart repeatedly with time advancing, so a scheduled attempt fires. */
async function tickPast(ms: number, svc: any, optedIn: boolean, starter: jest.Mock) {
  jest.advanceTimersByTime(ms)
  await considerRestart(svc, optedIn, starter as any)
}

describe('autoRestartSupervisor', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetAutoRestartState()
    mockAppendServiceNote.mockClear()
    mockSetDesiredStatus.mockClear()
    mockFindAutoRestartServices.mockClear()
    mockFindActive.mockResolvedValue({ id: 'profile-1' } as any)
    mockFindById.mockResolvedValue({ desiredStatus: 'running' } as any)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('never starts a service the active profile has not opted in', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, false, starter as any)
    await tickPast(60_000, SITE, false, starter)
    expect(starter).not.toHaveBeenCalled()
  })

  it('never starts a service that was deliberately stopped', async () => {
    const starter = jest.fn(async () => undefined)
    const stopped = { ...SITE, desiredStatus: 'stopped' }
    mockFindById.mockResolvedValue({ desiredStatus: 'stopped' } as any)
    await considerRestart(stopped, true, starter as any)
    await tickPast(60_000, stopped, true, starter)
    expect(starter).not.toHaveBeenCalled()
  })

  // The row is re-read at decision time, so a Stop that lands after the tick loaded its
  // snapshot still wins — the attempt scheduled a moment earlier is dropped, not fired.
  it('abandons a scheduled attempt when the service is stopped before it fires', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, true, starter as any)   // schedules an attempt
    mockFindById.mockResolvedValue({ desiredStatus: 'stopped' } as any)
    await tickPast(60_000, SITE, true, starter)
    expect(starter).not.toHaveBeenCalled()
  })

  it('schedules rather than starting on the first tick that sees the service down', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, true, starter as any)
    expect(starter).not.toHaveBeenCalled()
    expect(mockAppendServiceNote).toHaveBeenCalledWith(SITE.id, expect.stringContaining('first attempt in'))
  })

  it('starts the service once the first backoff has elapsed', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, true, starter as any)
    await tickPast(6_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledWith(SITE.id)
    expect(starter).toHaveBeenCalledTimes(1)
  })

  it('does not re-start while still inside the backoff window', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, true, starter as any)
    await tickPast(6_000, SITE, true, starter)
    await tickPast(1_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(1)
  })

  it('backs off further after a failed attempt and tries again', async () => {
    const starter = jest.fn(async () => { throw new Error('port still held') })
    await considerRestart(SITE, true, starter as any)
    await tickPast(6_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(1)
    expect(mockAppendServiceNote).toHaveBeenCalledWith(SITE.id, expect.stringContaining('FAILED'))

    // Second attempt waits the longer, backed-off delay rather than retrying at once.
    await tickPast(5_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(1)
    await tickPast(11_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(2)
  })

  it('records that the box wants a service running once it is seen listening', async () => {
    await noteServiceRunning(SITE.id, 'stopped')
    expect(mockSetDesiredStatus).toHaveBeenCalledWith(SITE.id, 'running')
  })

  it('does not rewrite desiredStatus that is already running', async () => {
    await noteServiceRunning(SITE.id, 'running')
    expect(mockSetDesiredStatus).not.toHaveBeenCalled()
  })

  it('clears the backoff after the service has stayed up long enough', async () => {
    const starter = jest.fn(async () => undefined)
    await considerRestart(SITE, true, starter as any)
    await tickPast(6_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(1)

    // Service comes back and stays up past the stability window.
    await noteServiceRunning(SITE.id, 'running')
    jest.advanceTimersByTime(121_000)
    await noteServiceRunning(SITE.id, 'running')
    expect(mockAppendServiceNote).toHaveBeenCalledWith(SITE.id, expect.stringContaining('recovered'))

    // A later death therefore starts again from the SHORT first delay, not the long one.
    await considerRestart(SITE, true, starter as any)
    await tickPast(6_000, SITE, true, starter)
    expect(starter).toHaveBeenCalledTimes(2)
  })

  it('opts in only the services the active profile flagged', async () => {
    mockFindAutoRestartServices.mockResolvedValue([{ serviceId: 'svc-site' }, { serviceId: 'svc-proxy' }] as any)
    const ids = await loadAutoRestartServiceIds()
    expect(ids.has('svc-site')).toBe(true)
    expect(ids.has('svc-proxy')).toBe(true)
    expect(ids.has('svc-comfy')).toBe(false)
  })

  it('opts in nothing when there is no active profile', async () => {
    mockFindActive.mockResolvedValue(null as any)
    const ids = await loadAutoRestartServiceIds()
    expect(ids.size).toBe(0)
    expect(mockFindAutoRestartServices).not.toHaveBeenCalled()
  })
})
