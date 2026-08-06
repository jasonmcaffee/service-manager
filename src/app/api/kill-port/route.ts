import { NextRequest, NextResponse } from 'next/server'
import { killPort, isPortListening } from '@/lib/util/portHelper'
import { serviceRepository } from '@/lib/repositories/serviceRepository'
import { processManager } from '@/lib/process-manager'
import { serviceService } from '@/lib/services/serviceService'
import { parseCudaDevices, resolveGuardedCudaDevice, reapGpuSurvivors, buildKnownExecutables } from '@/lib/util/gpuGuard'
import { appendServiceNote } from '@/lib/util/logTailer'

/**
 * After a port has been freed, checks the GPUs the owning service is pinned to for
 * processes still holding VRAM and reaps that service's own orphans.
 *
 * Killing the PID on a port is not the same as freeing the card: kill-port reported
 * success on 8080 while a different llama-server.exe still held 30 GB on GPU 1,
 * visible only in `nvidia-smi -i 1`'s per-process table (task-1493). Returns the
 * lines describing what was reaped or left behind, so the response says so plainly.
 * @param owner - the registered service that owns the port, if any
 */
async function sweepOwnerGpu(ownerId: string | undefined): Promise<string[]> {
  if (!ownerId) return []
  try {
    const owner = await serviceService.getService(ownerId)
    if (!owner) return []
    // getService already resolves the command's own pin over the registration.
    const devices = parseCudaDevices(resolveGuardedCudaDevice(owner.cudaDevice, owner.command))
    if (devices.length === 0) return []
    const all = await serviceRepository.findAll()
    const { notes } = await reapGpuSurvivors({
      devices,
      command: owner.command,
      ownerServiceId: owner.id,
      knownExecutables: buildKnownExecutables(all, owner.name),
    })
    for (const note of notes) appendServiceNote(owner.id, note)
    return notes
  } catch (err: any) {
    console.warn('[kill-port] post-kill VRAM sweep failed:', err?.message)
    return []
  }
}

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
      const vramNotes = await sweepOwnerGpu(owner?.id)
      const suffix = vramNotes.length > 0 ? `\n${vramNotes.join('\n')}` : ''
      return NextResponse.json({
        message: `Killed ${prefix}PID${pids.length > 1 ? 's' : ''}: ${pids.join(', ')}${suffix}`,
        pids,
        wsl,
        ...(vramNotes.length > 0 && { vramNotes }),
      })
    } else {
      return NextResponse.json({ message: `No process found on port ${port}` }, { status: 404 })
    }
  } catch (error: any) {
    return NextResponse.json({ message: error.message }, { status: 500 })
  }
}
