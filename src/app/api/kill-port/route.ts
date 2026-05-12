import { NextRequest, NextResponse } from 'next/server'
import { killPort, isPortListening } from '@/lib/util/portHelper'

export async function POST(request: NextRequest) {
  try {
    const { port } = await request.json()

    if (!port || isNaN(port) || port < 1 || port > 65535) {
      return NextResponse.json({ message: 'Invalid port number' }, { status: 400 })
    }

    const listening = await isPortListening(port)
    if (!listening) {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }

    const { killed, pids, wsl } = await killPort(port)

    if (killed) {
      const prefix = wsl ? 'WSL ' : ''
      return NextResponse.json({
        message: `Killed ${prefix}PID${pids.length > 1 ? 's' : ''}: ${pids.join(', ')}`,
        pids,
        wsl,
      })
    } else {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }
  } catch (error: any) {
    return NextResponse.json({ message: error.message }, { status: 500 })
  }
}
