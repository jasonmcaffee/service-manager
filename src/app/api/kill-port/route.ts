import { NextRequest, NextResponse } from 'next/server'
import { killPort, isPortListening } from '@/lib/util/portHelper'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { processManager } from '@/lib/process-manager'

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

    // Scope the kill to whichever registered service owns the port so an explicit
    // "Kill Port" is allowed to stop that service's own process, while every other
    // service (and the agent terminal daemons) stays protected.
    const owner = (await serviceRepository.findByPort(port))[0]
    const { killed, pids, wsl } = await killPort(port, {
      ownerServiceId: owner?.id,
      spawnedPids: owner ? processManager.getSpawnedPids(owner.id) : undefined,
    })

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
