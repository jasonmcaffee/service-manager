import { EventEmitter } from 'events'

/**
 * Creates a fresh ProcessManager-like mock for use in unit tests.
 * Never touches the globalThis singleton — safe to use in any test file.
 */
export function makeTestProcessManager() {
  return {
    hasBootStarted: jest.fn(() => false),
    markBootStarted: jest.fn(),
    isRunning: jest.fn((_id: string) => false),
    startService: jest.fn(async () => {}),
    stopService: jest.fn(async () => {}),
    restartService: jest.fn(async () => {}),
    getStatus: jest.fn((_id: string) => undefined as any),
    getOutput: jest.fn((_id: string) => [] as string[]),
    clearOutput: jest.fn(),
    adoptExternal: jest.fn(),
    verifyHealthWithMaps: jest.fn((_id: string, _port: any, _win: any, _wsl: any) => ({ healthy: true })),
    markUnhealthy: jest.fn(),
    markStopped: jest.fn(async () => {}),
    getPid: jest.fn((_id: string) => undefined as number | undefined),
    getAllStatuses: jest.fn(() => new Map()),
    hmrCleanup: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  }
}

export type TestProcessManager = ReturnType<typeof makeTestProcessManager>
