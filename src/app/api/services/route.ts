import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'

export async function GET() {
  try {
    const services = await serviceService.listServices()
    return NextResponse.json(services)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, description, command, startOnBoot, port, cudaDevice } = body

    const service = await serviceService.createService({
      name,
      description,
      command,
      startOnBoot,
      port: port ?? null,
      cudaDevice: cudaDevice ?? null,
    })

    return NextResponse.json(service, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
