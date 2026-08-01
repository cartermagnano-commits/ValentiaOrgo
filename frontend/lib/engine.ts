// "Choose Your Engine" — client-side engine selection.
//
// Only the *generative* explanation/chat features use this. Structure
// recognition and the reaction engine always run free & keyless.
//
// Storage policy:
//   - Non-secret prefs (mode, provider, model, tier) → localStorage (+ optional
//     Supabase sync for cross-device, handled by the settings UI).
//   - BYOK api key → sessionStorage only. Never written to Supabase, never sent
//     anywhere except per-request to our backend, which forwards it to the
//     chosen provider without persisting or logging it.

export type EngineMode = 'local' | 'byok' | 'hosted'
export type Provider = 'anthropic' | 'openai'

export interface EnginePrefs {
  mode: EngineMode
  provider: Provider
  model: string        // BYOK/hosted model id
  ollamaModel: string  // local model id
  tier: string         // hosted plan id
}

export interface EnginePayload {
  mode: EngineMode
  provider?: string | null
  model?: string | null
  api_key?: string | null
}

export interface StrengthStop {
  label: string
  model: string
  cost: string
}

// BYOK strength slider stops, per provider. Model ids are the current
// production ids; update here if providers rename them.
export const STRENGTH: Record<Provider, StrengthStop[]> = {
  anthropic: [
    { label: 'Haiku', model: 'claude-haiku-4-5', cost: '~$0.002 / explanation' },
    { label: 'Sonnet', model: 'claude-sonnet-4-6', cost: '~$0.01 / explanation' },
    { label: 'Opus', model: 'claude-opus-4-8', cost: '~$0.05 / explanation' },
  ],
  openai: [
    { label: 'GPT-4o mini', model: 'gpt-4o-mini', cost: '~$0.001 / explanation' },
    { label: 'GPT-4o', model: 'gpt-4o', cost: '~$0.01 / explanation' },
  ],
}

export const HOSTED_TIERS = [
  { id: 'study', name: 'Study', price: '$5/mo', cap: '~200 explanations / mo' },
  { id: 'plus', name: 'Plus', price: '$12/mo', cap: '~600 explanations / mo' },
  { id: 'unlimited', name: 'Unlimited', price: '$25/mo', cap: 'Unlimited (fair use)' },
]

export const OLLAMA_MODEL_CHOICES = ['llama3.2:1b', 'llama3.1:8b', 'qwen2.5:7b']

const PREFS_KEY = 'orgo.engine.prefs'
const APIKEY_KEY = 'orgo.engine.apikey'

export const DEFAULT_PREFS: EnginePrefs = {
  mode: 'local',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  ollamaModel: 'llama3.2:1b',
  tier: 'study',
}

export function loadPrefs(): EnginePrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS }
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: EnginePrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore quota / private-mode errors */
  }
}

// BYOK key lives in sessionStorage: survives navigation, clears on tab close.
export function getApiKey(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.sessionStorage.getItem(APIKEY_KEY) || ''
  } catch {
    return ''
  }
}

export function setApiKey(key: string): void {
  if (typeof window === 'undefined') return
  try {
    if (key) window.sessionStorage.setItem(APIKEY_KEY, key)
    else window.sessionStorage.removeItem(APIKEY_KEY)
  } catch {
    /* ignore */
  }
}

// Model ids are per-provider, so a stored pref can hold a model that doesn't
// belong to the stored provider — prefs saved before a provider switch, or by
// an older build of the picker. Sending that pair means the request reaches
// the right provider with an id it will reject, so fall back to the
// provider's own default instead of shipping the mismatch.
function modelForProvider(provider: Provider, model: string): string {
  const stops = STRENGTH[provider] ?? []
  return stops.some(s => s.model === model) ? model : stops[0]?.model ?? ''
}

// The object attached to /explain and /chat request bodies.
export function getEnginePayload(): EnginePayload {
  const p = loadPrefs()
  if (p.mode === 'local') {
    return { mode: 'local', model: p.ollamaModel || null }
  }
  const model = modelForProvider(p.provider, p.model)
  if (p.mode === 'byok') {
    return { mode: 'byok', provider: p.provider, model, api_key: getApiKey() || null }
  }
  return { mode: 'hosted', provider: p.provider, model }
}
