import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processManager, ServiceStatus } from '@/lib/process-manager'

// POST start all services marked for startup
export async function POST() {
  try {
    const services = await prisma.service.findMany({
      where: { startOnBoot: true },
      orderBy: { createdAt: 'asc' },
    })

    const results = []

    for (const service of services) {
      // Skip if already running
      if (processManager.isRunning(service.id)) {
        results.push({
          id: service.id,
          name: service.name,
          status: 'already_running',
        })
        continue
      }

      try {
        // Callback to persist state changes
        const onStateChange = async (status: ServiceStatus, pid?: number) => {
          await prisma.service.update({
            where: { id: service.id },
            data: {
              status,
              pid: pid ?? null,
            },
          })
        }

        await processManager.startService(
          service.id,
          service.command,
          onStateChange
        )
        
        results.push({
          id: service.id,
          name: service.name,
          status: 'started',
        })
        
        // Small delay between service starts
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch (error: any) {
        results.push({
          id: service.id,
          name: service.name,
          status: 'error',
          error: error.message,
        })
      }
    }

    return NextResponse.json({ results })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
