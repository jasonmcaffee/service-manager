/**
 * Service Lifecycle Tests
 *
 * Tests the full service lifecycle through serviceService (start, stop, restart,
 * update, delete) with all external dependencies mocked.
 * Verifies that config changes never affect running service state, that error-state
 * processes are cleaned up on restart, and that log fallback works after re-adoption.
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockTreeKill = jest.fn((pid: number, signal: string, cb?: (err: Error | null) => void) => {
  if (cb) cb(null)
})
jest.mock('tree-kill', () => mockTreeKill)

const mockIsRunning = jest.fn((_id: string) => false)
const mockGetStatus = jest.fn((_id: string): any => undefined)
const mockStartService = jest.fn(async () => {})
const mockStopService = jest.fn(async () => {})
const mockRestartService = jest.fn(async () => {})
const mockGetOutput = jest.fn((_id: string) => [] as string[])
const mockClearOutput = jest.fn()
const mockAdoptExternal = jest.fn()
const mockMarkUnhealthy = jest.fn()
const mockMarkBootStarted = jest.fn()
const mockHasBootStarted = jest.fn(() => false)
const mockGetPid = jest.fn((_id: string): number | undefined => undefined)

jest.mock('@/lib/process-manager', () => ({
  processManager: {
    isRunning: mockIsRunning,
    getStatus: mockGetStatus,
    startService: mockStartService,
    stopService: mockStopService,
    restartService: mockRestartService,
    getOutput: mockGetOutput,
    clearOutput: mockClearOutput,
    adoptExternal: mockAdoptExternal,
    markUnhealthy: mockMarkUnhealthy,
    markBootStarted: mockMarkBootStarted,
    hasBootStarted: mockHasBootStarted,
    getPid: mockGetPid,
    getSpawnedPids: jest.fn((_id: string) => [] as number[]),
    getTrackedPidsByService: jest.fn(() => new Map<string, number[]>()),
  },
}))

const mockFindAll = jest.fn(async () => [] as any[])
const mockFindById = jest.fn(async (_id: string): Promise<any> => null)
const mockFindByName = jest.fn(async () => null as any)
const mockUpdate = jest.fn(async (_id: string, _data: any) => ({ id: _id, ..._data } as any))
const mockCreate = jest.fn(async (input: any) => ({ id: 'new-id', ...input }))
const mockDelete = jest.fn(async () => {})
const mockFindByPort = jest.fn(async () => [] as any[])

jest.mock('@/lib/repositories/serviceRepository', () => ({
  serviceRepository: {
    findAll: mockFindAll,
    findById: mockFindById,
    findByName: mockFindByName,
    update: mockUpdate,
    create: mockCreate,
    delete: mockDelete,
    findByPort: mockFindByPort,
  },
}))

const mockFindActiveProfile = jest.fn(async () => null as any)
const mockUpsertProfileService = jest.fn(async () => ({}))

jest.mock('@/lib/repositories/runProfileRepository', () => ({
  runProfileRepository: {
    findActive: mockFindActiveProfile,
    findAutoStartServices: jest.fn(async () => []),
    findProfileService: jest.fn(async () => null),
    count: jest.fn(async () => 1),
    createProfileServicesForAllProfiles: jest.fn(async () => {}),
    upsertProfileService: mockUpsertProfileService,
  },
}))

jest.mock('@/lib/util/portHelper', () => ({
  killPort: jest.fn(async () => ({ killed: false, pids: [], wsl: false })),
  shutdownWsl: jest.fn(async () => {}),
  killMatchingProcesses: jest.fn(async () => {}),
  ensureWslPortProxy: jest.fn(async () => {}),
  extractServiceDir: jest.fn((cmd: string) => {
    const m = cmd.match(/cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s\r\n]+))/i)
    return m?.[1] ?? m?.[2] ?? m?.[3] ?? null
  }),
  getWslPidsOnPort: jest.fn(async () => [] as number[]),
  killWslPids: jest.fn(async () => [] as number[]),
  isWslProxyPid: jest.fn(async () => false),
  snapshotWindowsListeners: jest.fn(async () => new Map<number, number[]>()),
  snapshotWslListeners: jest.fn(async () => new Map<number, number[]>()),
}))

jest.mock('@/lib/lifecycle', () => ({
  onShutdown: jest.fn(),
  fireAllSync: jest.fn(),
}))

jest.mock('@/lib/services/init', () => ({
  initializeIfNeeded: jest.fn(async () => {}),
}))

jest.mock('@/lib/util/logTailer', () => ({
  getLogFilePath: jest.fn((id: string) => `/tmp/service-manager/logs/service-${id}.log`),
  // Real implementations — serviceService reads the log tail through these, so
  // stubbing them out silently broke the log-fallback path under test.
  readLogFileCapped: jest.requireActual('@/lib/util/logTailer').readLogFileCapped,
  INITIAL_TAIL_BYTES: jest.requireActual('@/lib/util/logTailer').INITIAL_TAIL_BYTES,
  MAX_LOG_BYTES: jest.requireActual('@/lib/util/logTailer').MAX_LOG_BYTES,
  logTailer: { start: jest.fn(), stop: jest.fn(), getRecent: jest.fn(() => []), stopAll: jest.fn() },
}))

// ── imports ───────────────────────────────────────────────────────────────────

import { serviceService } from '@/lib/services/serviceService'
import fs from 'fs'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeService(overrides: Partial<any> = {}): any {
  return {
    id: 'test-svc-id',
    name: 'Test Service',
    command: 'npm start',
    port: 8080,
    status: 'stopped',
    pid: null,
    wsl: false,
    noPort: false,
    cudaDevice: null,
    startOnBoot: false,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.startService', () => {
  it('calls processManager.startService with the correct command', async () => {
    const svc = makeService()
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 1234 })

    await serviceService.startService('test-svc-id')

    expect(mockStartService).toHaveBeenCalledWith(
      'test-svc-id',
      'npm start',
      expect.objectContaining({ PORT: '8080' }),
      expect.any(Function)
    )
  })

  it('sets PORT env var from service.port', async () => {
    const svc = makeService({ port: 9090 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 999 })

    await serviceService.startService('test-svc-id')

    expect(mockStartService).toHaveBeenCalledWith(
      'test-svc-id',
      expect.any(String),
      expect.objectContaining({ PORT: '9090' }),
      expect.any(Function)
    )
  })

  it('returns running status and pid after start', async () => {
    const svc = makeService()
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 5555 })

    const result = await serviceService.startService('test-svc-id')

    expect(result.status).toBe('running')
    expect(result.pid).toBe(5555)
  })

  it('throws 404 when service is not found', async () => {
    mockFindById.mockResolvedValue(null)

    await expect(serviceService.startService('missing-id')).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('kills port before starting any service with a port (clears watch-mode restarters)', async () => {
    const { killPort, shutdownWsl } = require('@/lib/util/portHelper')

    const svc = makeService({ wsl: false, port: 8080 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 123 })

    await serviceService.startService('test-svc-id')

    expect(shutdownWsl).not.toHaveBeenCalled()
    expect(killPort).toHaveBeenCalledWith(8080, expect.objectContaining({ ownerServiceId: 'test-svc-id' }))
  })

  it('kills matching watcher processes before starting a non-WSL service with a cd command', async () => {
    const { killMatchingProcesses, killPort, shutdownWsl } = require('@/lib/util/portHelper')

    const svc = makeService({ wsl: false, port: 4141, command: 'cd /d C:\\jason\\dev\\ai-proxy\nnpm run start:dev' })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 123 })

    await serviceService.startService('test-svc-id')

    expect(shutdownWsl).not.toHaveBeenCalled()
    expect(killMatchingProcesses).toHaveBeenCalledWith('C:\\jason\\dev\\ai-proxy', 'node_modules', 'test-svc-id')
    expect(killPort).toHaveBeenCalledWith(4141, expect.objectContaining({ ownerServiceId: 'test-svc-id' }))
  })

  it('kills port before starting a WSL service without shutting down WSL', async () => {
    const { killPort, shutdownWsl } = require('@/lib/util/portHelper')

    const svc = makeService({ wsl: true, port: 8080 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 123 })

    await serviceService.startService('test-svc-id')

    expect(shutdownWsl).not.toHaveBeenCalled()
    expect(killPort).toHaveBeenCalledWith(8080, expect.objectContaining({ ownerServiceId: 'test-svc-id' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.stopService', () => {
  it('calls processManager.stopService and returns stopped status', async () => {
    const svc = makeService({ status: 'running', pid: 333 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'stopped', pid: undefined })

    const result = await serviceService.stopService('test-svc-id')

    expect(mockStopService).toHaveBeenCalled()
    expect(result.status).toBe('stopped')
  })

  it('throws 404 when service is not found', async () => {
    mockFindById.mockResolvedValue(null)

    await expect(serviceService.stopService('missing-id')).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('is a no-op (no throw) when service is already stopped', async () => {
    const svc = makeService({ status: 'stopped', pid: null })
    mockFindById.mockResolvedValue(svc)
    mockIsRunning.mockReturnValue(false)
    mockGetStatus.mockReturnValue({ status: 'stopped' })

    await expect(serviceService.stopService('test-svc-id')).resolves.not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.restartService', () => {
  it('calls processManager.restartService with correct arguments', async () => {
    const svc = makeService({ port: 7070 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 777 })

    await serviceService.restartService('test-svc-id')

    expect(mockRestartService).toHaveBeenCalledWith(
      'test-svc-id',
      'npm start',
      expect.objectContaining({ PORT: '7070' }),
      expect.any(Function)
    )
  })

  it('throws 404 when service is not found', async () => {
    mockFindById.mockResolvedValue(null)

    await expect(serviceService.restartService('missing-id')).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.updateService — does NOT stop running services', () => {
  it('preserves status=running when updating the service name', async () => {
    const svc = makeService({ status: 'running', pid: 1234 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 1234 })

    const result = await serviceService.updateService('test-svc-id', { name: 'Renamed' }, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })

    // Running status is preserved from processManager
    expect(result.status).toBe('running')
    expect(result.pid).toBe(1234)
    // processManager.stopService must NOT be called
    expect(mockStopService).not.toHaveBeenCalled()
    expect(mockStartService).not.toHaveBeenCalled()
  })

  it('preserves status=running when toggling startOnBoot', async () => {
    const svc = makeService({ status: 'running', pid: 555 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 555 })
    // startOnBoot is a profile-scoped field, so the write needs an active profile
    // to land on (task-1523); the rest of this suite runs profile-less.
    mockFindActiveProfile.mockResolvedValue({ id: 'profile-1', name: 'Default', isActive: true, services: [] } as any)

    const result = await serviceService.updateService('test-svc-id', { startOnBoot: false } as any, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })

    expect(result.status).toBe('running')
    expect(mockStopService).not.toHaveBeenCalled()
    expect(mockUpsertProfileService).toHaveBeenCalledWith('profile-1', 'test-svc-id', { startOnBoot: false })
    mockFindActiveProfile.mockResolvedValue(null as any)
  })

  it('preserves status=running when updating the command', async () => {
    const svc = makeService({ status: 'running', pid: 999 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 999 })

    const result = await serviceService.updateService('test-svc-id', { command: 'npm run prod' }, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })

    expect(result.status).toBe('running')
    expect(mockStopService).not.toHaveBeenCalled()
  })

  it('throws 400 when new port is out of range', async () => {
    const svc = makeService()
    mockFindById.mockResolvedValue(svc)

    await expect(
      serviceService.updateService('test-svc-id', { port: 99999 }, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 409 when new port is already used by another service', async () => {
    const svc = makeService()
    mockFindById.mockResolvedValue(svc)
    mockFindByPort.mockResolvedValue([{ id: 'other-svc', name: 'Other' }])

    await expect(
      serviceService.updateService('test-svc-id', { port: 8080 }, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('throws 404 when service to update is not found', async () => {
    mockFindById.mockResolvedValue(null)

    await expect(
      serviceService.updateService('missing', { name: 'X' }, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.deleteService', () => {
  it('stops the service before deleting when it is running', async () => {
    mockIsRunning.mockReturnValue(true)

    await serviceService.deleteService('test-svc-id', { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })

    expect(mockStopService).toHaveBeenCalledWith('test-svc-id')
    expect(mockDelete).toHaveBeenCalledWith('test-svc-id')
  })

  it('deletes without stopping when service is already stopped', async () => {
    mockIsRunning.mockReturnValue(false)

    await serviceService.deleteService('test-svc-id', { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })

    expect(mockStopService).not.toHaveBeenCalled()
    expect(mockDelete).toHaveBeenCalledWith('test-svc-id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.getService — log fallback after re-adoption', () => {
  it('returns output from logTailer when process is tracked in memory', async () => {
    const svc = makeService({ status: 'running', pid: 1 })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 1 })
    mockGetOutput.mockReturnValue(['log line 1', 'log line 2'])

    const result = await serviceService.getService('test-svc-id')

    expect(result!.output).toEqual(['log line 1', 'log line 2'])
  })

  it('falls back to reading the log file when processManager has no entry (after HMR)', async () => {
    const svc = makeService({ status: 'stopped' })
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue(undefined) // no in-memory entry = service survived HMR

    // Write a log file that represents the service's last run
    const logFile = require('@/lib/util/logTailer').getLogFilePath('test-svc-id')
    const testDir = require('path').dirname(logFile)
    if (!require('fs').existsSync(testDir)) {
      require('fs').mkdirSync(testDir, { recursive: true })
    }
    require('fs').writeFileSync(logFile, 'historical line A\nhistorical line B\n')

    const result = await serviceService.getService('test-svc-id')

    // Log file lines should be returned when no in-memory buffer exists
    expect(result!.output.some((l: string) => l.includes('historical line A'))).toBe(true)
    expect(result!.output.some((l: string) => l.includes('historical line B'))).toBe(true)
  })

  it('returns empty array when no in-memory entry and no log file exists', async () => {
    const svc = makeService()
    mockFindById.mockResolvedValue(svc)
    mockGetStatus.mockReturnValue(undefined)

    // Make sure the log file does not exist
    const logFile = require('@/lib/util/logTailer').getLogFilePath('test-svc-id')
    if (require('fs').existsSync(logFile)) require('fs').unlinkSync(logFile)

    const result = await serviceService.getService('test-svc-id')

    expect(result!.output).toEqual([])
  })

  it('returns null when service does not exist', async () => {
    mockFindById.mockResolvedValue(null)

    const result = await serviceService.getService('missing-id')

    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.createService', () => {
  it('validates port range on create', async () => {
    await expect(
      serviceService.createService({ name: 'X', command: 'x', port: 0 } as any, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects duplicate port with 409', async () => {
    mockFindByPort.mockResolvedValue([{ id: 'other', name: 'Other' }])

    await expect(
      serviceService.createService({ name: 'X', command: 'x', port: 8080 } as any, { reason: 'Test change: exercising this path with a recorded reason', author: 'api' })
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('serviceService.listServices — status reconciliation', () => {
  it('marks stopped when processManager has a tracked but dead process (spawned child exited)', async () => {
    const svc = makeService({ status: 'running', pid: 999 })
    mockFindAll.mockResolvedValue([svc])
    // mem present (tracked), but isRunning false => spawned child died or PID dead
    mockGetStatus.mockReturnValue({ status: 'running', pid: 999, process: null, id: svc.id })
    mockIsRunning.mockReturnValue(false)

    const [result] = await serviceService.listServices()

    expect(result.status).toBe('stopped')
    expect(result.pid).toBeNull()
  })

  it('trusts DB=running when processManager has no entry (adoption hasn\'t happened yet)', async () => {
    // Reproduces the vllm-startup bug: a WSL service whose adoption failed
    // (e.g. transient `wsl` snapshot failure) must NOT be flipped to stopped here.
    // The reconciler is the authority for that decision.
    const svc = makeService({ status: 'running', pid: 999 })
    mockFindAll.mockResolvedValue([svc])
    mockGetStatus.mockReturnValue(undefined) // never adopted in this session
    mockIsRunning.mockReturnValue(false)

    const [result] = await serviceService.listServices()

    expect(result.status).toBe('running')
    expect(result.pid).toBe(999)
  })

  it('overrides DB status with in-memory running status', async () => {
    const svc = makeService({ status: 'stopped', pid: null })
    mockFindAll.mockResolvedValue([svc])
    mockIsRunning.mockReturnValue(true)
    mockGetStatus.mockReturnValue({ status: 'running', pid: 1234 })

    const [result] = await serviceService.listServices()

    expect(result.status).toBe('running')
    expect(result.pid).toBe(1234)
  })
})
