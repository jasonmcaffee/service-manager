import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const service = await serviceService.getService(params.id)
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    return NextResponse.json(service)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json()
    const { name, description, command, startOnBoot, port, cudaDevice } = body

    const service = await serviceService.updateService(params.id, {
      name,
      description,
      command,
      startOnBoot,
      port: port ?? null,
      cudaDevice: cudaDevice ?? null,
    })

    return NextResponse.json(service)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await serviceService.deleteService(params.id)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
