// Generative engine selection — hosted only. Every AI call runs on the
// server-side key configured in the backend .env (the Parley gateway);
// there is nothing for users to configure.
//
// Only the *generative* explanation/chat features use this. Structure
// recognition and the reaction engine always run free & keyless.

export interface EnginePayload {
  mode: 'hosted'
  provider: 'anthropic'
  model?: string | null
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

// The object attached to /explain, /stereo, and /chat request bodies.
// Without a model the server's HOSTED_ANTHROPIC_MODEL decides what runs.
export function getEnginePayload(modelOverride?: string | null): EnginePayload {
  return { mode: 'hosted', provider: 'anthropic', ...(modelOverride ? { model: modelOverride } : {}) }
}
