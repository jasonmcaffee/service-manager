export interface EffectiveConfig {
  serviceId: string
  command: string
  port: number | null
  cudaDevice: string | null
  startOnBoot: boolean
}

export type DiffAction = 'start' | 'stop' | 'restart' | 'noop'

/**
 * Produces a stable string key representing the runtime-relevant parts of a config.
 * Two configs with the same key can share a running process.
 * @param c - effective config to hash
 */
export function configKey(c: EffectiveConfig): string {
  return JSON.stringify([c.command, c.port, c.cudaDevice])
}

/**
 * Compares the previous and next profile's effective configs and determines the
 * minimal set of start/stop/restart operations needed.
 *
 * Rules (evaluated in order):
 *   - Currently running + config changed → restart
 *   - Currently running + not startOnBoot in next → stop
 *   - Not running + startOnBoot in next → start
 *   - Everything else → noop
 *
 * @param prev - effective configs for the outgoing profile
 * @param next - effective configs for the incoming profile
 * @param isRunning - predicate that returns live running state for a service
 */
export function diffProfiles(
  prev: EffectiveConfig[],
  next: EffectiveConfig[],
  isRunning: (serviceId: string) => boolean
): Map<string, DiffAction> {
  const prevMap = new Map(prev.map(c => [c.serviceId, c]))
  const nextMap = new Map(next.map(c => [c.serviceId, c]))
  const actions = new Map<string, DiffAction>()

  const allIds = new Set([...prevMap.keys(), ...nextMap.keys()])

  for (const id of allIds) {
    const p = prevMap.get(id)
    const n = nextMap.get(id)
    const running = isRunning(id)

    if (running && n && p && configKey(n) !== configKey(p)) {
      // Config changed and service is currently running — restart with new config
      actions.set(id, 'restart')
    } else if (running && (!n || !n.startOnBoot)) {
      // Service is running but no longer auto-start in the new profile — stop it
      actions.set(id, 'stop')
    } else if (!running && n?.startOnBoot) {
      // Service should auto-start in new profile but is not running — start it
      actions.set(id, 'start')
    } else {
      actions.set(id, 'noop')
    }
  }

  return actions
}
