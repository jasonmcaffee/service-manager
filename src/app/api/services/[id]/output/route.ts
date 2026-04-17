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
