import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processManager } from '@/lib/process-manager'

// GET single service
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const service = await prisma.service.findUnique({
      where: { id: params.id },
    })

    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    // Verify status from memory state
    const memoryState = processManager.getStatus(params.id)
    let status = service.status
    let pid = service.pid
    
    if (memoryState) {
      status = memoryState.status
      pid = memoryState.pid ?? null
    }

    return NextResponse.json({
      ...service,
      status,
      pid,
      output: memoryState?.output || [],
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PUT update service - ONLY updates config, preserves runtime state
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json()
    const { name, description, command, startOnBoot } = body

    // Get current service to preserve runtime state
    const current = await prisma.service.findUnique({
      where: { id: params.id },
    })

    if (!current) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    // Check memory state for current runtime status
    const memoryState = processManager.getStatus(params.id)
    const currentStatus = memoryState?.status || current.status
    const currentPid = memoryState?.pid || current.pid

    // Update ONLY the configuration fields, preserve runtime state
    const service = await prisma.service.update({
      where: { id: params.id },
      data: {
        name,
        description,
        command,
        startOnBoot,
        // Preserve runtime state
        status: currentStatus,
        pid: currentPid ?? null,
      },
    })

    return NextResponse.json({
      ...service,
      status: currentStatus,
      pid: currentPid,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE service
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Stop the service if running
    if (processManager.isRunning(params.id)) {
      await processManager.stopService(params.id)
    }

    await prisma.service.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
