/**
 * Next.js server-boot hook. Runs exactly once when the manager process starts,
 * before any HTTP request is served, so start-on-boot services are launched even
 * if no browser ever opens the Service Manager UI. Previously autostart only
 * fired from the client page load / a fragile boot curl, so a headless reboot
 * left flagged services (llama.cpp, comfyui) stopped. Node.js runtime only.
 */
export async function register(): Promise<void> {
  // Positive `=== 'nodejs'` guard (not an early return): webpack replaces
  // process.env.NEXT_RUNTIME with a compile-time literal, so this whole block —
  // including the dynamic import of Node-only code (child_process via
  // process-manager) — is dead-code-eliminated from the edge-runtime bundle.
  // An early `return` guard would leave the import() reachable to webpack and
  // trigger "Module not found: Can't resolve 'child_process'".
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeIfNeeded } = await import('@/lib/services/init')
    try {
      console.log('[instrumentation] running boot initialization')
      await initializeIfNeeded()
      console.log('[instrumentation] boot initialization complete')
    } catch (err) {
      console.error('[instrumentation] boot initialization failed:', err)
    }
  }
}
