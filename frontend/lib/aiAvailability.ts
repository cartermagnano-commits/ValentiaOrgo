// Whether an AI-backed feature (structure recognition from a photo, chat,
// explanations) has any key to actually run on: the user's own BYOK key in
// Settings, or — for a self-hosted deployment that never asked its users for
// one — the backend's own server-side ANTHROPIC_API_KEY/OPENAI_API_KEY.
//
// Without either, /analyze and /react-from-image degrade all the way to
// "no structure recognized" with no indication that a key would fix it (the
// deployed-to-Railway target has no server key at all, so this is the common
// case there). Callers use this to fail fast with an honest message instead
// of making a request that can only come back empty.
//
// /health reports hosted_key_configured and is both keyless and exempt from
// the proxy-secret check, so this works even before Settings has ever been
// opened and even against a backend that requires the proxy secret elsewhere.
import { loadApiKey } from './engine'

let cache: { value: boolean; at: number } | null = null
const CACHE_MS = 15_000

export async function hasUsableApiKey(): Promise<boolean> {
  if (loadApiKey()) return true
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  try {
    const res = await fetch('/health', { cache: 'no-store' })
    const data = await res.json()
    const value = Boolean(data?.hosted_key_configured)
    cache = { value, at: Date.now() }
    return value
  } catch {
    // Can't reach the backend at all — that's ApiStatusBanner's job to
    // surface, not this check's. Don't compound it with a misleading
    // "add an API key" message; let the normal request path fail on its
    // own terms.
    return true
  }
}
