import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processManager } from '@/lib/process-manager'

// Initialize process manager state from database on first request
let initialized = false

async function initializeProcessManager() {
  if (initialized) return
  initialized = true
  
  const services = await prisma.service.findMany()
  for (const service of services) {
    if (service.pid && service.status === 'running') {
      processManager.restoreFromDb(service.id, service.pid, 'running')
      
      // Verify and update if process is no longer running
      if (!processManager.isRunning(service.id)) {
        await prisma.service.update({
          where: { id: service.id },
          data: { status: 'stopped', pid: null }
        })
      }
    }
  }
}

// GET all services
export async function GET() {
  try {
    await initializeProcessManager()
    
    const services = await prisma.service.findMany({
      orderBy: { createdAt: 'asc' },
    })

    // Verify running services are actually still running
    const servicesWithVerifiedStatus = await Promise.all(
      services.map(async (service) => {
        let status = service.status
        let pid = service.pid
        
        // Double-check running processes
        if (status === 'running' && pid) {
          const isActuallyRunning = processManager.isRunning(service.id)
          if (!isActuallyRunning) {
            status = 'stopped'
            pid = null
            // Update DB
            await prisma.service.update({
              where: { id: service.id },
              data: { status: 'stopped', pid: null }
            })
          }
        }
        
        // Also check in-memory state in case DB is out of sync
        const memoryState = processManager.getStatus(service.id)
        if (memoryState?.status === 'running' && memoryState.pid) {
          status = 'running'
          pid = memoryState.pid
        }
        
        return {
          ...service,
          status,
          pid,
        }
      })
    )

    return NextResponse.json(servicesWithVerifiedStatus)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST create new service
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, description, command, startOnBoot } = body

    const service = await prisma.service.create({
      data: {
        name,
        description,
        command,
        startOnBoot: startOnBoot ?? false,
        status: 'stopped',
        pid: null,
      },
    })

    return NextResponse.json(service, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
