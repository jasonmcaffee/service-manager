/**
 * Central registry for process shutdown cleanup handlers.
 * Modules register cleanup fns here; SIGTERM/SIGINT/exit fires them all.
 */

let installed = false
const handlers: Array<{ name: string; fn: () => Promise<void> | void }> = []

/**
 * Register a cleanup function that runs when the process exits cleanly.
 * @param name - short label for logging
 * @param fn - cleanup function (sync or async)
 */
export function onShutdown(name: string, fn: () => Promise<void> | void): void {
  handlers.push({ name, fn })
  if (!installed) install()
}

async function fireAll(signal: string): Promise<void> {
  console.log(`[lifecycle] ${signal} — running ${handlers.length} cleanup handlers`)
  await Promise.allSettled(handlers.map(async ({ name, fn }) => {
    try {
      await fn()
    } catch (err) {
      console.error(`[lifecycle] cleanup "${name}" threw:`, err)
    }
  }))
  process.exit(0)
}

function install(): void {
  installed = true
  process.once('SIGINT', () => void fireAll('SIGINT'))
  process.once('SIGTERM', () => void fireAll('SIGTERM'))
}

/** Called by hot-reload singleton replacement to run cleanup synchronously. */
export function fireAllSync(): void {
  for (const { name, fn } of handlers) {
    try {
      const result = fn()
      // Best-effort: can't await in sync context but most cleanups are sync (clearInterval)
      if (result instanceof Promise) result.catch(err => console.error(`[lifecycle] ${name}:`, err))
    } catch (err) {
      console.error(`[lifecycle] cleanup "${name}" threw:`, err)
    }
  }
  handlers.length = 0
  installed = false
}
