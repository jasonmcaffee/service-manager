import { NextRequest, NextResponse } from 'next/server'
import { listRevisions } from '@/lib/services/configRevisionService'

/**
 * Returns a service's configuration change log, newest first. Backs the History tab
 * in the service settings modal.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const rawLimit = request.nextUrl.searchParams.get('limit')
    const limit = rawLimit ? Math.max(1, Math.min(500, parseInt(rawLimit, 10) || 50)) : 50
    const revisions = await listRevisions(params.id, limit)
    return NextResponse.json({ revisions })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
