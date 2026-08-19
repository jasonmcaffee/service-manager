import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const output = serviceService.getOutput(params.id)
    const status = serviceService.getProcessStatus(params.id)
    return NextResponse.json({
      output,
      // Survives the truncation every start performs on the run log, so the card can
      // still say why the previous run ended (task-1593).
      events: serviceService.getEvents(params.id, 12),
      status: status?.status || 'stopped',
      pid: status?.pid,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    serviceService.clearOutput(params.id)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
