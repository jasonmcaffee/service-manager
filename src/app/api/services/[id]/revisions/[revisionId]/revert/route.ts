import { NextRequest, NextResponse } from 'next/server'
import { serviceService } from '@/lib/services/serviceService'
import { extractChangeContext } from '@/lib/util/changeReason'

/**
 * Restores the configuration captured by an earlier revision. The revert is itself a
 * reasoned change: it needs its own reason and appends a new `revert` revision rather
 * than rewriting history.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; revisionId: string } }
) {
  try {
    const body = await request.json().catch(() => null)
    const { reason, author } = extractChangeContext(request, body)

    const result = await serviceService.revertToRevision(params.id, params.revisionId, {
      reason: reason ?? '',
      author,
    })
    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 500 })
  }
}
