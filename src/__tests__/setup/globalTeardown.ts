import { execSync } from 'child_process'

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

export default async function globalTeardown() {
  const baseline = parseInt(process.env.JEST_NODE_BASELINE ?? '0')
  const after = getNodeCount()
  const delta = after - baseline

  // Jest worker processes (maxWorkers: '50%') are still alive when globalTeardown runs —
  // they're counted as node processes. Allow up to 24 extra before flagging a real leak.
  const JEST_WORKER_HEADROOM = 24

  if (delta > JEST_WORKER_HEADROOM) {
    console.error(`[processGuard] LEAK DETECTED: ${delta} extra node processes after tests (was ${baseline}, now ${after})`)
    process.exitCode = 1
  } else {
    console.log(`[processGuard] node process delta: ${delta >= 0 ? '+' : ''}${delta} (baseline=${baseline}, after=${after}) — OK`)
  }
}
