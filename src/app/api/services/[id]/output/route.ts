import { NextRequest, NextResponse } from 'next/server'
import { processManager } from '@/lib/process-manager'

// GET service output
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const output = processManager.getOutput(params.id)
    const status = processManager.getStatus(params.id)
    
    return NextResponse.json({
      output,
      status: status?.status || 'stopped',
      pid: status?.pid,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE clear output
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    processManager.clearOutput(params.id)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
