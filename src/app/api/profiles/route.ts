import { NextRequest, NextResponse } from 'next/server'
import { runProfileService } from '@/lib/services/runProfileService'

export async function GET() {
  try {
    const profiles = await runProfileService.listProfiles()
    return NextResponse.json(profiles)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json()
    if (!name?.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const profile = await runProfileService.createProfile(name.trim())
    return NextResponse.json(profile, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
