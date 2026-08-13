import { NextRequest } from 'next/server'

/** Who made a configuration change. Best-effort, taken from the request. */
export type ChangeAuthor = 'ui' | 'agent' | 'api'

/** The provenance of a configuration change: why it happened and who made it. */
export interface ChangeContext {
  reason: string
  author: ChangeAuthor
}

const REASON_HEADER = 'x-change-reason'
const AUTHOR_HEADER = 'x-change-author'

/**
 * Normalises a free-form author string to one of the known values, so a caller
 * cannot inject arbitrary text into the audit trail's author column.
 * @param raw - the author value supplied by the caller
 */
function normalizeAuthor(raw: unknown): ChangeAuthor | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'ui' || value === 'agent' || value === 'api') return value
  return null
}

/**
 * Guesses whether a request came from the Service Manager web UI rather than a
 * script. Browsers send Sec-Fetch-* on every fetch(); curl and node clients do
 * not. Only used for attribution — an explicit x-change-author always wins.
 * @param request - the incoming request
 */
function looksLikeBrowser(request: NextRequest): boolean {
  const mode = request.headers.get('sec-fetch-mode')
  const site = request.headers.get('sec-fetch-site')
  return Boolean(mode || site)
}

/**
 * Pulls the change reason out of a request, accepting it three ways so no caller
 * is boxed out: the JSON body's `reason`, an `x-change-reason` header, or a
 * `?reason=` query parameter. The header/query forms exist because DELETE has no
 * natural body and agents drive this API from terse curl.
 *
 * Returns the raw string (or null) — validation lives in configRevisionService so
 * every path is rejected identically.
 * @param request - the incoming request
 * @param body - the already-parsed JSON body, when the route has one
 */
export function extractReason(request: NextRequest, body?: Record<string, unknown> | null): string | null {
  const fromBody = body && typeof body.reason === 'string' ? body.reason : null
  const fromHeader = request.headers.get(REASON_HEADER)
  const fromQuery = request.nextUrl?.searchParams?.get('reason') ?? null
  const value = fromBody ?? fromHeader ?? fromQuery
  return value && value.trim() ? value : null
}

/**
 * Determines who to credit a change to: an explicit body/header value when given,
 * otherwise 'ui' for a browser request and 'api' for anything else.
 * @param request - the incoming request
 * @param body - the already-parsed JSON body, when the route has one
 */
export function extractAuthor(request: NextRequest, body?: Record<string, unknown> | null): ChangeAuthor {
  const explicit = normalizeAuthor(body?.author) ?? normalizeAuthor(request.headers.get(AUTHOR_HEADER))
  if (explicit) return explicit
  return looksLikeBrowser(request) ? 'ui' : 'api'
}

/**
 * Convenience wrapper returning both halves of a change's provenance.
 * @param request - the incoming request
 * @param body - the already-parsed JSON body, when the route has one
 */
export function extractChangeContext(request: NextRequest, body?: Record<string, unknown> | null): { reason: string | null; author: ChangeAuthor } {
  return { reason: extractReason(request, body), author: extractAuthor(request, body) }
}
