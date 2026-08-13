import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'
import { extractChangeContext } from '@/lib/util/changeReason'

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
    const { name, description, command, port, noPort, wsl, minFreeVramMb, cudaDevice, startOnBoot } = body

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
    if (minFreeVramMb !== undefined) input.minFreeVramMb = minFreeVramMb ?? null
    // cudaDevice and startOnBoot are stored on the active profile's override row;
    // the service layer routes them there. Dropping cudaDevice here is what made this
    // endpoint answer 200 while silently discarding the field (task-1493), and
    // dropping startOnBoot is why the card's Auto-start toggle never stuck.
    if (cudaDevice !== undefined) input.cudaDevice = cudaDevice ?? null
    if (startOnBoot !== undefined) input.startOnBoot = Boolean(startOnBoot)

    const { reason, author } = extractChangeContext(request, body)
    const service = await serviceService.updateService(params.id, input as any, { reason: reason ?? '', author })

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
    // A DELETE has no natural body, so the reason usually arrives as a header or
    // query param; a body is still accepted for callers that send one.
    const body = await request.json().catch(() => null)
    const { reason, author } = extractChangeContext(request, body)

    await serviceService.deleteService(params.id, { reason: reason ?? '', author })
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
