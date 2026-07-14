'use client'

import { useEffect, useState } from 'react'
import { Cpu, KeyRound, Cloud, Check, ExternalLink } from 'lucide-react'
import {
  loadPrefs,
  savePrefs,
  getApiKey,
  setApiKey,
  STRENGTH,
  HOSTED_TIERS,
  OLLAMA_MODEL_CHOICES,
  DEFAULT_PREFS,
  type EngineMode,
  type EnginePrefs,
  type Provider,
} from '../../lib/engine'
import { getCurrentUser, loadEngineSettings, saveEngineSettings } from '../../lib/database'
import { useToast } from './Toast'

interface OllamaStatus {
  running: boolean
  models: string[]
  vision_available: boolean
  error: string | null
}

const MODULES: { mode: EngineMode; title: string; tagline: string; Icon: any }[] = [
  { mode: 'local', title: 'Local (Ollama)', tagline: 'Free, private, on your hardware', Icon: Cpu },
  { mode: 'byok', title: 'Your own API key', tagline: 'Anthropic or OpenAI, billed to you', Icon: KeyRound },
  { mode: 'hosted', title: 'Hosted', tagline: 'No setup — we run everything', Icon: Cloud },
]

export default function EngineSettings({
  onboarding = false,
  onDone,
}: {
  onboarding?: boolean
  onDone?: () => void
} = {}) {
  const [prefs, setPrefs] = useState<EnginePrefs>(loadPrefs())
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [saved, setSaved] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const { notify } = useToast()

  useEffect(() => {
    setPrefs(loadPrefs())
    setApiKeyInput(getApiKey())
    // Best-effort: pull non-secret prefs from Supabase for cross-device sync.
    getCurrentUser().then(async user => {
      if (!user) return
      setUserId(user.id)
      try {
        const remote = await loadEngineSettings(user.id)
        if (remote) {
          const merged = { ...DEFAULT_PREFS, ...loadPrefs(), ...remote } as EnginePrefs
          savePrefs(merged)
          setPrefs(merged)
        }
      } catch {
        /* table may not be migrated yet — localStorage still works */
      }
    })
  }, [])

  // Probe local Ollama whenever the Local card is the active one.
  useEffect(() => {
    if (prefs.mode !== 'local') return
    let cancelled = false
    fetch('/engine/ollama-status')
      .then(r => r.json())
      .then(data => { if (!cancelled) setOllama(data) })
      .catch(() => { if (!cancelled) setOllama({ running: false, models: [], vision_available: false, error: 'unreachable' }) })
    return () => { cancelled = true }
  }, [prefs.mode])

  function update(patch: Partial<EnginePrefs>) {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      // Fire-and-forget cross-device sync (non-secret prefs only).
      if (userId) saveEngineSettings(userId, next as unknown as Record<string, unknown>).catch(() => {})
      return next
    })
    setSaved(false)
  }

  function selectMode(mode: EngineMode) {
    update({ mode })
  }

  function persistKey() {
    setApiKey(apiKeyInput.trim())
    setSaved(true)
    notify(apiKeyInput.trim() ? 'API key saved for this session' : 'API key cleared', 'success')
  }

  async function finishOnboarding() {
    // Persist even untouched defaults — the saved row is what tells the
    // dashboard this user has been through onboarding. Resolve the user on
    // demand rather than relying on the userId state: clicking "Continue"
    // before the mount-time lookup resolves would otherwise skip the save and
    // bounce the user straight back here from the dashboard gate.
    try {
      const uid = userId ?? (await getCurrentUser())?.id
      if (uid) await saveEngineSettings(uid, prefs as unknown as Record<string, unknown>)
    } catch {
      // Offline / table not migrated — still proceed, but say so instead of
      // silently letting the dashboard bounce back to onboarding.
      notify('Could not save engine settings — you may see this screen again.', 'error')
    }
    onDone?.()
  }

  const strengthStops = STRENGTH[prefs.provider]
  const strengthIndex = Math.max(0, strengthStops.findIndex(s => s.model === prefs.model))
  const activeStrength = strengthStops[strengthIndex] ?? strengthStops[0]
  const tierIndex = Math.max(0, HOSTED_TIERS.findIndex(t => t.id === prefs.tier))
  const activeTier = HOSTED_TIERS[tierIndex] ?? HOSTED_TIERS[0]

  return (
    <div className="engine-settings">
      <header className="es-head">
        <h2>{onboarding ? 'Welcome — choose your AI engine' : 'Choose your engine'}</h2>
        <p className="es-framing">
          {onboarding
            ? 'One quick choice before you start: what should power AI explanations and chat? Chemistry itself — structure recognition and reaction prediction — is always free and keyless. You can change this anytime under Settings.'
            : 'Structure recognition and the reaction engine always run free and keyless. This setting only controls what powers explanations and chat.'}
        </p>
      </header>

      <div className="es-stack">
        {MODULES.map(({ mode, title, tagline, Icon }) => {
          const active = prefs.mode === mode
          return (
            <div key={mode} className={`es-card ${active ? 'active' : ''}`}>
              <button
                type="button"
                className="es-card-head"
                aria-pressed={active}
                onClick={() => selectMode(mode)}
              >
                <span className="es-radio" data-on={active}>{active && <Check size={12} />}</span>
                <span className="es-icon"><Icon size={18} /></span>
                <span className="es-titles">
                  <span className="es-title">{title}</span>
                  <span className="es-tag">{tagline}</span>
                </span>
              </button>

              <div className={`es-body ${active ? 'open' : ''}`}>
                <div className="es-body-inner">
                  {mode === 'local' && (
                    <LocalPanel
                      ollama={ollama}
                      model={prefs.ollamaModel}
                      onModel={m => update({ ollamaModel: m })}
                    />
                  )}
                  {mode === 'byok' && (
                    <ByokPanel
                      provider={prefs.provider}
                      onProvider={p => update({ provider: p, model: STRENGTH[p][0].model })}
                      apiKey={apiKeyInput}
                      onApiKey={setApiKeyInput}
                      onSaveKey={persistKey}
                      saved={saved}
                      stops={strengthStops}
                      index={strengthIndex}
                      active={activeStrength}
                      onStrength={i => update({ model: strengthStops[i].model })}
                    />
                  )}
                  {mode === 'hosted' && (
                    <HostedPanel
                      index={tierIndex}
                      active={activeTier}
                      onTier={i => update({ tier: HOSTED_TIERS[i].id })}
                      onChosen={() => notify(`${activeTier.name} plan noted — billing isn’t enabled yet`, 'info')}
                    />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {onboarding && (
        <footer className="es-continue">
          <button type="button" className="es-continue-btn" onClick={finishOnboarding}>
            Continue to your workspace →
          </button>
          <p className="es-note" style={{ textAlign: 'center' }}>
            Not sure? Just continue — the default works out of the box.
          </p>
        </footer>
      )}

      <style jsx>{`
        .engine-settings {
          max-width: 640px; margin: 0 auto; padding: 32px 22px 48px;
          color: var(--text);
        }
        .es-head h2 { font-size: 22px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
        .es-framing { color: var(--muted); font-size: 13.5px; line-height: 1.55; margin: 0 0 20px; }
        .es-stack { display: flex; flex-direction: column; gap: 10px; }
        .es-card {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; overflow: hidden;
          box-shadow: var(--shadow-sm); transition: box-shadow .2s, border-color .2s;
        }
        .es-card.active { border-color: var(--accent); box-shadow: 0 4px 14px rgba(24,32,42,0.10); }
        .es-card-head {
          width: 100%; display: flex; align-items: center; gap: 12px;
          padding: 14px 16px; background: none; border: none; cursor: pointer; text-align: left;
          color: var(--text); font: inherit;
        }
        .es-radio {
          width: 17px; height: 17px; border-radius: 50%; border: 2px solid var(--border-strong);
          display: inline-flex; align-items: center; justify-content: center; color: #fff; flex: none;
        }
        .es-radio[data-on='true'] { background: var(--accent); border-color: var(--accent); }
        .es-icon { color: var(--accent); display: inline-flex; flex: none; }
        .es-titles { display: flex; flex-direction: column; gap: 1px; }
        .es-title { font-weight: 600; font-size: 14px; }
        .es-tag { font-size: 12px; color: var(--muted); }
        .es-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease; }
        .es-body.open { grid-template-rows: 1fr; }
        .es-body-inner { overflow: hidden; }
        .es-continue { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
        .es-continue-btn {
          width: 100%; padding: 12px; border: none; border-radius: 8px; cursor: pointer;
          background: var(--primary); color: #fff; font: inherit; font-weight: 600; font-size: 14px;
        }
        .es-continue-btn:hover { background: var(--primary-hover); }
      `}</style>
      <style jsx global>{`
        .engine-settings .es-panel { padding: 2px 16px 18px 45px; display: flex; flex-direction: column; gap: 13px; font-size: 13.5px; }
        .engine-settings .es-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 10px; border-radius: 999px; font-weight: 600; }
        .engine-settings .es-pill.ok { background: rgba(35,107,69,0.12); color: var(--success); }
        .engine-settings .es-pill.bad { background: rgba(169,74,66,0.12); color: var(--danger); }
        .engine-settings .es-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .engine-settings .es-label { font-weight: 600; font-size: 12.5px; }
        .engine-settings select, .engine-settings input[type='password'] {
          font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 7px; border: 1px solid var(--border);
          background: #fff; color: var(--text);
        }
        .engine-settings input[type='password'] { width: 100%; margin-top: 6px; }
        .engine-settings .es-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
        .engine-settings .es-tab { padding: 6px 14px; background: #fff; border: none; cursor: pointer; font: inherit; font-size: 13px; color: var(--text); }
        .engine-settings .es-tab.on { background: var(--accent); color: #fff; }
        .engine-settings .es-note { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 0; }
        .engine-settings .es-slider { display: flex; align-items: center; gap: 0; padding: 6px 0; }
        .engine-settings .es-stop { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; position: relative; }
        .engine-settings .es-stop::before { content: ''; position: absolute; top: 7px; left: -50%; width: 100%; height: 2px; background: var(--border); z-index: 0; }
        .engine-settings .es-stop:first-child::before { display: none; }
        .engine-settings .es-dot { width: 15px; height: 15px; border-radius: 50%; background: #fff; border: 2px solid var(--border-strong); z-index: 1; }
        .engine-settings .es-stop.on .es-dot { background: var(--accent); border-color: var(--accent); }
        .engine-settings .es-stop-label { font-size: 11px; color: var(--muted); text-align: center; }
        .engine-settings .es-readout { font-size: 12.5px; color: var(--muted); }
        .engine-settings .es-readout strong { color: var(--text); }
        .engine-settings .es-cta {
          align-self: flex-start; margin-top: 2px; padding: 8px 16px; border-radius: 8px; border: none;
          background: var(--accent); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
        }
        .engine-settings .es-cta.accent { background: var(--accent2); }
        .engine-settings a.es-link { color: var(--accent); display: inline-flex; align-items: center; gap: 4px; }
      `}</style>
    </div>
  )
}

function LocalPanel({ ollama, model, onModel }: { ollama: OllamaStatus | null; model: string; onModel: (m: string) => void }) {
  const running = ollama?.running
  const choices = Array.from(new Set([...(ollama?.models ?? []), ...OLLAMA_MODEL_CHOICES]))
  return (
    <div className="es-panel">
      <div className="es-row">
        <span className="es-label">Ollama status:</span>
        {ollama === null ? (
          <span className="es-pill">checking…</span>
        ) : running ? (
          <span className="es-pill ok"><Check size={12} /> detected</span>
        ) : (
          <span className="es-pill bad">not detected</span>
        )}
      </div>
      {running ? (
        <div className="es-row">
          <span className="es-label">Model:</span>
          <select value={model} onChange={e => onModel(e.target.value)}>
            {choices.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      ) : (
        <p className="es-note">
          Ollama isn’t running. Install it, then pull a model (e.g. <code>ollama pull llama3.2:1b</code>).{' '}
          <a className="es-link" href="https://ollama.com" target="_blank" rel="noreferrer">
            ollama.com <ExternalLink size={12} />
          </a>
        </p>
      )}
      <p className="es-note">Nothing leaves your machine. Runs on your own hardware, no key required.</p>
    </div>
  )
}

function ByokPanel({
  provider, onProvider, apiKey, onApiKey, onSaveKey, saved, stops, index, active, onStrength,
}: {
  provider: Provider; onProvider: (p: Provider) => void
  apiKey: string; onApiKey: (v: string) => void; onSaveKey: () => void; saved: boolean
  stops: { label: string; model: string; cost: string }[]; index: number
  active: { label: string; model: string; cost: string }; onStrength: (i: number) => void
}) {
  return (
    <div className="es-panel">
      <div className="es-row">
        <span className="es-label">Provider:</span>
        <div className="es-tabs">
          <button type="button" className={`es-tab ${provider === 'anthropic' ? 'on' : ''}`} onClick={() => onProvider('anthropic')}>Anthropic</button>
          <button type="button" className={`es-tab ${provider === 'openai' ? 'on' : ''}`} onClick={() => onProvider('openai')}>OpenAI</button>
        </div>
      </div>

      <div>
        <span className="es-label">API key</span>
        <input
          type="password"
          value={apiKey}
          onChange={e => onApiKey(e.target.value)}
          placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          autoComplete="off"
        />
        <p className="es-note">🔒 Sent per-request only. Never stored on our servers, never written to your account.</p>
      </div>

      <div>
        <span className="es-label">Model strength</span>
        <div className="es-slider">
          {stops.map((s, i) => (
            <div key={s.model} className={`es-stop ${i === index ? 'on' : ''}`} onClick={() => onStrength(i)}>
              <span className="es-dot" />
              <span className="es-stop-label">{s.label}</span>
            </div>
          ))}
        </div>
        <div className="es-readout">You selected <strong>{active.label}</strong> (<code>{active.model}</code>) · {active.cost}</div>
      </div>

      <button type="button" className="es-cta" onClick={onSaveKey}>{saved ? 'Key saved ✓' : 'Save my key'}</button>
    </div>
  )
}

function HostedPanel({ index, active, onTier, onChosen }: { index: number; active: { name: string; price: string; cap: string }; onTier: (i: number) => void; onChosen: () => void }) {
  return (
    <div className="es-panel">
      <p className="es-note">We run everything. Just sign in — no key, no install.</p>
      <div>
        <span className="es-label">Plan</span>
        <div className="es-slider">
          {HOSTED_TIERS.map((t, i) => (
            <div key={t.id} className={`es-stop ${i === index ? 'on' : ''}`} onClick={() => onTier(i)}>
              <span className="es-dot" />
              <span className="es-stop-label">{t.name}</span>
            </div>
          ))}
        </div>
        <div className="es-readout"><strong>{active.name}</strong> · {active.price} · {active.cap}</div>
      </div>
      <button type="button" className="es-cta accent" onClick={() => onChosen()}>Choose this plan</button>
      <p className="es-note">Billing isn’t enabled yet — selecting a plan just records your preference for now.</p>
    </div>
  )
}
