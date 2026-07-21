import { diffProfiles, EffectiveConfig } from '@/lib/services/profileDiff'

const base: EffectiveConfig = {
  serviceId: 'svc-1',
  command: 'echo hello',
  port: 8080,
  cudaDevice: '0',
  startOnBoot: true,
}

function cfg(overrides: Partial<EffectiveConfig>): EffectiveConfig {
  return { ...base, ...overrides }
}

const notRunning = (_id: string) => false
const running = (_id: string) => true

describe('diffProfiles', () => {
  it('returns noop for identical configs when service is running', () => {
    const actions = diffProfiles([base], [base], running)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('returns noop for identical configs when service is not running and not startOnBoot', () => {
    const c = cfg({ startOnBoot: false })
    const actions = diffProfiles([c], [c], notRunning)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('returns restart when cudaDevice differs and service is running', () => {
    const actions = diffProfiles(
      [cfg({ cudaDevice: '0' })],
      [cfg({ cudaDevice: '1' })],
      running
    )
    expect(actions.get('svc-1')).toBe('restart')
  })

  it('returns restart when port differs and service is running', () => {
    const actions = diffProfiles(
      [cfg({ port: 8080 })],
      [cfg({ port: 9090 })],
      running
    )
    expect(actions.get('svc-1')).toBe('restart')
  })

  it('returns restart when command differs and service is running', () => {
    const actions = diffProfiles(
      [cfg({ command: 'cmd-a' })],
      [cfg({ command: 'cmd-b' })],
      running
    )
    expect(actions.get('svc-1')).toBe('restart')
  })

  it('returns stop when service is running but not startOnBoot in next profile', () => {
    const actions = diffProfiles(
      [cfg({ startOnBoot: true })],
      [cfg({ startOnBoot: false })],
      running
    )
    expect(actions.get('svc-1')).toBe('stop')
  })

  it('returns start when service becomes startOnBoot and is not running', () => {
    const actions = diffProfiles(
      [cfg({ startOnBoot: false })],
      [cfg({ startOnBoot: true })],
      notRunning
    )
    expect(actions.get('svc-1')).toBe('start')
  })

  it('returns noop for service not running and not startOnBoot in either profile', () => {
    const c = cfg({ startOnBoot: false })
    const actions = diffProfiles([c], [c], notRunning)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('returns noop for running service with different startOnBoot but same config', () => {
    // startOnBoot changed but service is already running — no stop since it's still autostart
    const actions = diffProfiles(
      [cfg({ startOnBoot: false })],
      [cfg({ startOnBoot: true })],
      running
    )
    // Running + startOnBoot in next + same configKey → noop (not restart, not stop)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('handles service only in prev (removed from next) — stops if running', () => {
    const actions = diffProfiles([base], [], running)
    expect(actions.get('svc-1')).toBe('stop')
  })

  it('handles service only in next (new in next) — starts if startOnBoot', () => {
    const actions = diffProfiles([], [cfg({ startOnBoot: true })], notRunning)
    expect(actions.get('svc-1')).toBe('start')
  })

  // ── task-609: profile switches must not stop things they never started ─────

  it('leaves a shared service running and attached when both profiles match (2 Comfy case)', () => {
    const shared = cfg({ startOnBoot: true, cudaDevice: '0' })
    const actions = diffProfiles([shared], [shared], running)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('does NOT stop a manually-started service that neither profile auto-starts', () => {
    const manual = cfg({ startOnBoot: false })
    const actions = diffProfiles([manual], [manual], running)
    expect(actions.get('svc-1')).toBe('noop')
  })

  it('stops a running service only when the OUTGOING profile was managing it', () => {
    const wasManaged = diffProfiles([cfg({ startOnBoot: true })], [cfg({ startOnBoot: false })], running)
    const neverManaged = diffProfiles([cfg({ startOnBoot: false })], [cfg({ startOnBoot: false })], running)
    expect(wasManaged.get('svc-1')).toBe('stop')
    expect(neverManaged.get('svc-1')).toBe('noop')
  })

  it('never touches a protected service, whatever the diff says', () => {
    const isProtected = (_id: string) => true
    expect(diffProfiles([cfg({ startOnBoot: true })], [cfg({ startOnBoot: false })], running, isProtected).get('svc-1')).toBe('noop')
    expect(diffProfiles([cfg({ cudaDevice: '0' })], [cfg({ cudaDevice: '1' })], running, isProtected).get('svc-1')).toBe('noop')
    expect(diffProfiles([cfg({ startOnBoot: false })], [cfg({ startOnBoot: true })], notRunning, isProtected).get('svc-1')).toBe('noop')
  })

  it('does not restart a running service that is leaving the profile, even if its config changed', () => {
    const actions = diffProfiles(
      [cfg({ startOnBoot: true, cudaDevice: '0' })],
      [cfg({ startOnBoot: false, cudaDevice: '1' })],
      running
    )
    expect(actions.get('svc-1')).toBe('stop')
  })

  it('handles multiple services independently', () => {
    const svc2: EffectiveConfig = { serviceId: 'svc-2', command: 'cmd', port: null, cudaDevice: null, startOnBoot: false }
    const isRunning = (id: string) => id === 'svc-1'

    const actions = diffProfiles(
      [base, svc2],
      [cfg({ cudaDevice: '1' }), svc2],
      isRunning
    )
    expect(actions.get('svc-1')).toBe('restart')
    expect(actions.get('svc-2')).toBe('noop')
  })
})
