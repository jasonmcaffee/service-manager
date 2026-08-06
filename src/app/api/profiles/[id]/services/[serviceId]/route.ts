import { NextRequest, NextResponse } from 'next/server'
import { runProfileService } from '@/lib/services/runProfileService'

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; serviceId: string } }
) {
  try {
    const body = await request.json()
    const { cudaDevice, startOnBoot } = body
    const result = await runProfileService.upsertServiceOverride(params.id, params.serviceId, {
      cudaDevice: cudaDevice !== undefined ? cudaDevice : undefined,
      startOnBoot: startOnBoot !== undefined ? startOnBoot : undefined,
    })
    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
