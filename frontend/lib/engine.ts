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

// The chat composer's per-prompt model choices. Model ids are the current
// production ids; update here if providers rename them.
export const STRENGTH: { anthropic: StrengthStop[] } = {
  anthropic: [
    { label: 'Haiku', model: 'claude-haiku-4-5', cost: '~$0.002 / reply' },
    { label: 'Sonnet', model: 'claude-sonnet-4-6', cost: '~$0.01 / reply' },
    { label: 'Opus', model: 'claude-opus-4-8', cost: '~$0.05 / reply' },
  ],
}

// The object attached to /explain, /stereo, and /chat request bodies.
// Without a model the server's HOSTED_ANTHROPIC_MODEL decides what runs.
export function getEnginePayload(modelOverride?: string | null): EnginePayload {
  return { mode: 'hosted', provider: 'anthropic', ...(modelOverride ? { model: modelOverride } : {}) }
}
