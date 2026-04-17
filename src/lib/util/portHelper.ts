import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function killPort(port: number): Promise<{ killed: boolean; pids: number[] }> {
  const { stdout } = await execAsync(
    `netstat -ano | findstr ":${port}" | findstr "LISTENING"`
  ).catch(() => ({ stdout: '' }))

  if (!stdout.trim()) return { killed: false, pids: [] }

  const lines = stdout.trim().split('\n')
  const pidSet = new Set<number>()
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[parts.length - 1])
    if (!isNaN(pid)) pidSet.add(pid)
  }

  const killed: number[] = []
  for (const pid of Array.from(pidSet)) {
    try {
      await execAsync(`taskkill /PID ${pid} /T /F`)
      killed.push(pid)
    } catch (err: any) {
      if (!err.message?.includes('not found')) {
        console.error(`Failed to kill PID ${pid}:`, err.message)
      }
    }
  }

  return { killed: killed.length > 0, pids: killed }
}

export async function isPortListening(port: number): Promise<boolean> {
  const { stdout } = await execAsync(
    `netstat -ano | findstr ":${port}" | findstr "LISTENING"`
  ).catch(() => ({ stdout: '' }))
  return stdout.trim().length > 0
}
