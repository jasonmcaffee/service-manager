import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { port } = body

    if (!port || isNaN(port)) {
      return NextResponse.json({ message: 'Invalid port number' }, { status: 400 })
    }

    // Find process using the port
    const { stdout: netstatOutput } = await execAsync(
      `netstat -ano | findstr ":${port}" | findstr "LISTENING"`
    ).catch(() => ({ stdout: '' }))

    if (!netstatOutput.trim()) {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }

    // Extract PIDs from netstat output
    const lines = netstatOutput.trim().split('\n')
    const pids = new Set<string>()
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && !isNaN(parseInt(pid))) {
        pids.add(pid)
      }
    }

    if (pids.size === 0) {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }

    // Kill each process
    const killedPids: string[] = []
    const errors: string[] = []

    for (const pid of pids) {
      try {
        await execAsync(`taskkill /PID ${pid} /T /F`)
        killedPids.push(pid)
      } catch (error: any) {
        // Check if it's just "process not found" which is fine
        if (!error.message?.includes('not found')) {
          errors.push(`PID ${pid}: ${error.message}`)
        }
      }
    }

    if (killedPids.length > 0) {
      return NextResponse.json({
        message: `Killed PID${killedPids.length > 1 ? 's' : ''}: ${killedPids.join(', ')}`,
        pids: killedPids,
      })
    } else if (errors.length > 0) {
      return NextResponse.json({ message: errors.join('; ') }, { status: 500 })
    } else {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }
  } catch (error: any) {
    return NextResponse.json({ message: error.message }, { status: 500 })
  }
}
