// Generative engine selection — BYOK. Every AI call runs on a key the user
// pastes into Settings; the deployed backend has no server-side key at all.
// The key lives in this browser's localStorage and rides along with each
// request, never persisted server-side (see EngineConfig in app.py).
//
// Only the *generative* features use this — explanations, chat, and (since
// local OSR is no longer deployed) structure recognition. The reaction engine
// and pathway search are deterministic and run free & keyless.

export interface EnginePayload {
  // 'byok' when a key is saved in Settings; otherwise 'hosted', so a
  // self-hosted backend with its own server-side ANTHROPIC_API_KEY keeps
  // working for a visitor who never pasted a key (pre-BYOK behavior).
  mode: 'byok' | 'hosted'
  provider: 'anthropic'
  model?: string | null
  api_key?: string
}

export interface StrengthStop {
  label: string
  model: string
  cost: string
}

// API-model choices revealed by the chat composer's lightning-bolt override.
// ASKCOS remains the default reaction mode; these ids only apply when the user
// explicitly bypasses it for a prompt.
export const STRENGTH: { anthropic: StrengthStop[] } = {
  anthropic: [
    { label: 'Haiku', model: 'claude-haiku-4-5', cost: '~$0.002 / reply' },
    { label: 'Sonnet', model: 'claude-sonnet-4-6', cost: '~$0.01 / reply' },
    { label: 'Opus', model: 'claude-opus-4-8', cost: '~$0.05 / reply' },
  ],
}

// The preferred API-model pick is remembered across sessions, and Settings
// edits the same preference — both go through here so the key stays in one place.
const MODEL_KEY = 'orgo.chat.model'

export function loadPreferredModel(): string {
  if (typeof window === 'undefined') return STRENGTH.anthropic[0].model
  try {
    const saved = window.localStorage.getItem(MODEL_KEY)
    if (saved && STRENGTH.anthropic.some(s => s.model === saved)) return saved
  } catch { /* fall through to the default */ }
  return STRENGTH.anthropic[0].model
}

export function savePreferredModel(model: string): void {
  try { window.localStorage.setItem(MODEL_KEY, model) } catch { /* preference is best-effort */ }
}

// The user's own API key. A Parley gateway key (sk-parley-…) or a real
// Anthropic key both work — the backend routes by prefix. Stored per-browser,
// never sent anywhere but our own backend.
const API_KEY_KEY = 'orgo.engine.apiKey'

export function loadApiKey(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(API_KEY_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveApiKey(key: string): void {
  try {
    const trimmed = key.trim()
    if (trimmed) window.localStorage.setItem(API_KEY_KEY, trimmed)
    else window.localStorage.removeItem(API_KEY_KEY)
  } catch { /* storage unavailable — the key just won't persist */ }
}

// The object attached to /explain, /stereo, and /chat request bodies.
// Without a model the server's default decides what runs.
export function getEnginePayload(modelOverride?: string | null): EnginePayload {
  const key = loadApiKey()
  return {
    // Only claim BYOK when there's actually a key to send — otherwise the
    // backend enforces BYOK's "API key required" rule even when it has a
    // perfectly usable server-side key of its own (self-hosted deployments).
    mode: key ? 'byok' : 'hosted',
    provider: 'anthropic',
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(key ? { api_key: key } : {}),
  }
}
