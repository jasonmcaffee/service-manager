import { NextRequest, NextResponse } from 'next/server'
import { runProfileService } from '@/lib/services/runProfileService'

export async function GET() {
  try {
    const profile = await runProfileService.getActiveProfile()
    if (!profile) return NextResponse.json({ error: 'No active profile' }, { status: 404 })
    return NextResponse.json(profile)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { profileId } = await request.json()
    if (!profileId) {
      return NextResponse.json({ error: 'profileId is required' }, { status: 400 })
    }
    const { profile } = await runProfileService.switchProfile(profileId)
    return NextResponse.json(profile)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
