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
 *   - Protected service (agent terminal daemon) → noop, always
 *   - Running + startOnBoot in next + config changed → restart
 *   - Running + startOnBoot in next + config identical → noop (stays attached)
 *   - Running + not startOnBoot in next + WAS startOnBoot in prev → stop
 *   - Running + not startOnBoot in either profile → noop (started by hand — leave it)
 *   - Not running + startOnBoot in next → start
 *   - Everything else → noop
 *
 * The "started by hand" rule is why a profile switch no longer stops services the
 * user launched manually; only services the outgoing profile was managing are
 * stopped when they leave the profile.
 *
 * @param prev - effective configs for the outgoing profile
 * @param next - effective configs for the incoming profile
 * @param isRunning - predicate that returns live running state for a service
 * @param isProtected - predicate marking services a profile switch must never touch
 */
export function diffProfiles(
  prev: EffectiveConfig[],
  next: EffectiveConfig[],
  isRunning: (serviceId: string) => boolean,
  isProtected: (serviceId: string) => boolean = () => false
): Map<string, DiffAction> {
  const prevMap = new Map(prev.map(c => [c.serviceId, c]))
  const nextMap = new Map(next.map(c => [c.serviceId, c]))
  const actions = new Map<string, DiffAction>()

  const allIds = new Set([...prevMap.keys(), ...nextMap.keys()])

  for (const id of allIds) {
    actions.set(id, resolveAction(prevMap.get(id), nextMap.get(id), isRunning(id), isProtected(id)))
  }

  return actions
}

/**
 * Resolves the action for a single service from its previous/next config and
 * current running state. Split out so the rule table stays readable.
 * @param p - effective config in the outgoing profile (undefined if absent)
 * @param n - effective config in the incoming profile (undefined if absent)
 * @param running - whether the service is currently running
 * @param isProtected - whether the service may never be touched by a switch
 */
function resolveAction(p: EffectiveConfig | undefined, n: EffectiveConfig | undefined, running: boolean, isProtected: boolean): DiffAction {
  if (isProtected) return 'noop'

  if (running) {
    if (n?.startOnBoot) {
      return p && configKey(n) !== configKey(p) ? 'restart' : 'noop'
    }
    // Only stop what the outgoing profile was actually managing. A service the
    // user started by hand is not the profile's to stop.
    return p?.startOnBoot ? 'stop' : 'noop'
  }

  return n?.startOnBoot ? 'start' : 'noop'
}
