/**
 * Global test guard: no unit test may reach the real SQLite database.
 *
 * Most suites mock the repositories they exercise, but a service can call a
 * repository the suite never thought about — the change-log recorder (task-1523) is
 * exactly that: it runs after every config mutation. Without this, running the suite
 * would append test rows to the live service-manager.db. Any model/operation is
 * answered with a harmless default; a suite that cares about the data mocks its own
 * repository, which takes precedence over this.
 */

/** Safe default for each Prisma operation, matching the shape callers expect. */
function defaultFor(operation: string): unknown {
  if (operation === 'findMany') return []
  if (operation === 'findUnique' || operation === 'findFirst') return null
  if (operation === 'count') return 0
  return {}
}

jest.mock('@/lib/db', () => {
  const model = new Proxy({}, {
    get: (_target, operation: string) => jest.fn(async () => defaultFor(operation)),
  })
  const prisma = new Proxy({}, {
    get: (_target, prop: string) => {
      if (prop === 'then') return undefined
      if (prop === '$transaction') return jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(prisma) : []))
      if (prop === '$connect' || prop === '$disconnect') return jest.fn(async () => {})
      return model
    },
  })
  return { prisma }
})

export {}
