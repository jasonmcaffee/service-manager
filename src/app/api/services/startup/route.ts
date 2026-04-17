import { NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'

export async function POST() {
  try {
    const result = await serviceService.runAutoStart()
    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
