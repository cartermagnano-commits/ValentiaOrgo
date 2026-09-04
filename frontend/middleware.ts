// Server-side proxy to the FastAPI backend.
//
// This replaces the rewrites() rules for API paths because rewrites CANNOT
// add request headers, and the backend now requires a shared secret proving
// the request came from us. The secret is read from a NON-public env var, so
// it stays on the server and never reaches the browser.
//
// The backend uses the same header to decide whether X-Forwarded-For can be
// trusted for per-user rate limiting — see proxy_auth.py.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Tolerate a base URL entered without a scheme ("host.up.railway.app"), which
// is the easy mistake to make in a hosting dashboard. Without this, `new URL`
// below throws and EVERY proxied path returns an opaque
// MIDDLEWARE_INVOCATION_FAILED 500 with nothing naming the cause.
function normalizeBase(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '')
  if (!value) return 'http://127.0.0.1:8000'
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

const apiBase = normalizeBase(process.env.NEXT_PUBLIC_ORGO_API_BASE_URL)

export function middleware(request: NextRequest) {
  let url: URL
  try {
    url = new URL(request.nextUrl.pathname + request.nextUrl.search, apiBase)
  } catch {
    // A malformed NEXT_PUBLIC_ORGO_API_BASE_URL is a deploy-config error, not a
    // request error. Say so plainly instead of crashing the edge function.
    return NextResponse.json(
      { detail: 'Backend URL is misconfigured. Check NEXT_PUBLIC_ORGO_API_BASE_URL.' },
      { status: 503 },
    )
  }

  const headers = new Headers(request.headers)
  const secret = process.env.ORGO_PROXY_SECRET
  if (secret) headers.set('x-orgo-proxy-secret', secret)

  // Vercel's edge sets x-forwarded-for to the real client; a client-supplied
  // value does not survive it. Normalize to the first hop so the backend's
  // "trust the leftmost entry" rule has exactly one value to read.
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) headers.set('x-forwarded-for', forwarded)

  return NextResponse.rewrite(url, { request: { headers } })
}

// Every backend path the app calls — the same allowlist that used to live in
// next.config.mjs as apiPaths, moved here verbatim. Deliberately explicit
// rather than a wildcard: this list IS the public API surface, and a deploy
// change should not silently widen it. Add a path here when the backend gains
// a route the browser must reach. /structure and /molfile are loaded via
// <img src> but still travel through this proxy, so they need the header like
// any other path.
export const config = {
  matcher: [
    '/analyze',
    '/analyze/verify/:token*',
    '/predict',
    '/structure',
    '/molfile',
    '/pathways',
    '/explain',
    '/stereo',
    '/chat',
    '/assist',
    '/react',
    // An exact path match, so '/react' does NOT cover '/react/assess'.
    '/react/assess',
    '/react-from-image',
    '/engine/ollama-status',
    '/engine/usage',
    '/engine/template-gaps',
    '/health',
  ],
}
