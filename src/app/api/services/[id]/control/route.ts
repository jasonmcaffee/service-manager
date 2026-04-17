import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { action } = await request.json()

    let result
    switch (action) {
      case 'start':
        result = await serviceService.startService(params.id)
        break
      case 'stop':
        result = await serviceService.stopService(params.id)
        break
      case 'restart':
        result = await serviceService.restartService(params.id)
        break
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
