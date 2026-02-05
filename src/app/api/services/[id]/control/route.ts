import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processManager, ServiceStatus } from '@/lib/process-manager'

// POST start/stop/restart service
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json()
    const { action } = body // 'start' | 'stop' | 'restart'

    const service = await prisma.service.findUnique({
      where: { id: params.id },
    })

    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    // Callback to persist state changes to database
    const onStateChange = async (status: ServiceStatus, pid?: number) => {
      await prisma.service.update({
        where: { id: params.id },
        data: {
          status,
          pid: pid ?? null,
        },
      })
    }

    switch (action) {
      case 'start':
        await processManager.startService(
          service.id,
          service.command,
          onStateChange
        )
        break
      case 'stop':
        await processManager.stopService(service.id, onStateChange)
        break
      case 'restart':
        await processManager.restartService(
          service.id,
          service.command,
          onStateChange
        )
        break
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // Get updated state
    const memoryState = processManager.getStatus(params.id)
    const updatedService = await prisma.service.findUnique({
      where: { id: params.id },
    })

    return NextResponse.json({
      id: service.id,
      status: memoryState?.status || updatedService?.status || 'stopped',
      pid: memoryState?.pid || updatedService?.pid,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
