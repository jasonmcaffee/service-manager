import { execSync } from 'child_process'

/** Snapshots the node process count before the test suite runs. */
function getNodeCount(): number {
  try {
    const out = execSync(
      'powershell -NoProfile -NonInteractive -Command "(Get-Process node -EA SilentlyContinue).Count"',
      { timeout: 10_000, stdio: 'pipe' }
    ).toString().trim()
    return parseInt(out) || 0
  } catch {
    return 0
  }
}

export default async function globalSetup() {
  const count = getNodeCount()
  // Store on env so globalTeardown can read it (globalThis doesn't persist across Jest workers)
  process.env.JEST_NODE_BASELINE = String(count)
  console.log(`[processGuard] baseline node processes: ${count}`)
}
