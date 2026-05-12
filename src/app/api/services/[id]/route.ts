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
    const { name, description, command, port, noPort, wsl } = body

    // Only include fields present in the request body so callers can patch a
    // single field (e.g. wsl=true) without triggering port-uniqueness checks
    // for unchanged ports.
    const input: Record<string, unknown> = {}
    if (name !== undefined) input.name = name
    if (description !== undefined) input.description = description
    if (command !== undefined) input.command = command
    if (port !== undefined) input.port = port ?? null
    if (noPort !== undefined) input.noPort = noPort
    if (wsl !== undefined) input.wsl = wsl

    const service = await serviceService.updateService(params.id, input as any)

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
