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

const MODULES: { mode: EngineMode; title: string; tagline: string; strip: string; Icon: any }[] = [
  { mode: 'local', title: 'Local (Ollama)', tagline: '$0 · your hardware', strip: '#6d5bd0', Icon: Cpu },
  { mode: 'byok', title: 'Bring Your Own Key', tagline: '~$0 · billed to you', strip: '#1f6f5c', Icon: KeyRound },
  { mode: 'hosted', title: 'Hosted — "Just Works"', tagline: '$5/mo placeholder', strip: '#c0562f', Icon: Cloud },
]

export default function EngineSettings() {
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

  const strengthStops = STRENGTH[prefs.provider]
  const strengthIndex = Math.max(0, strengthStops.findIndex(s => s.model === prefs.model))
  const activeStrength = strengthStops[strengthIndex] ?? strengthStops[0]
  const tierIndex = Math.max(0, HOSTED_TIERS.findIndex(t => t.id === prefs.tier))
  const activeTier = HOSTED_TIERS[tierIndex] ?? HOSTED_TIERS[0]

  return (
    <div className="engine-settings">
      <header className="es-head">
        <h2>Choose your engine</h2>
        <p className="es-framing">
          Structure recognition and the reaction engine always run <strong>free and keyless</strong>.
          This setting only controls what powers the generative <em>explanations and chat</em>.
        </p>
      </header>

      <div className="es-stack">
        {MODULES.map(({ mode, title, tagline, strip, Icon }) => {
          const active = prefs.mode === mode
          return (
            <div key={mode} className={`es-card ${active ? 'active' : ''}`} style={{ ['--strip' as any]: strip }}>
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

      <style jsx>{`
        .engine-settings {
          --paper: #f3f0e7; --ink: #16201c; --muted: #5c6560; --flask: #1f6f5c;
          max-width: 720px; margin: 0 auto; padding: 28px 22px 48px;
          color: var(--ink); font-family: -apple-system, Segoe UI, Roboto, sans-serif;
        }
        .es-head h2 {
          font-family: 'Iowan Old Style', Georgia, serif; font-size: 30px;
          margin: 0 0 8px; letter-spacing: -0.01em;
        }
        .es-framing { color: var(--muted); font-size: 14px; line-height: 1.5; margin: 0 0 22px; }
        .es-stack { display: flex; flex-direction: column; gap: 14px; }
        .es-card {
          background: var(--paper); border: 1px solid rgba(22,32,28,0.12);
          border-left: 5px solid var(--strip); border-radius: 16px; overflow: hidden;
          box-shadow: 0 1px 2px rgba(22,32,28,0.05); transition: box-shadow .2s, border-color .2s;
        }
        .es-card.active { box-shadow: 0 8px 24px rgba(22,32,28,0.12); border-color: var(--strip); }
        .es-card-head {
          width: 100%; display: flex; align-items: center; gap: 12px;
          padding: 16px 18px; background: none; border: none; cursor: pointer; text-align: left;
        }
        .es-radio {
          width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--muted);
          display: inline-flex; align-items: center; justify-content: center; color: #fff; flex: none;
        }
        .es-radio[data-on='true'] { background: var(--strip); border-color: var(--strip); }
        .es-icon { color: var(--strip); display: inline-flex; flex: none; }
        .es-titles { display: flex; flex-direction: column; }
        .es-title { font-weight: 600; font-size: 15px; }
        .es-tag { font-size: 12px; color: var(--muted); }
        .es-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease; }
        .es-body.open { grid-template-rows: 1fr; }
        .es-body-inner { overflow: hidden; }
      `}</style>
      <style jsx global>{`
        .engine-settings .es-panel { padding: 4px 18px 20px; display: flex; flex-direction: column; gap: 14px; font-size: 14px; }
        .engine-settings .es-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; border-radius: 999px; font-weight: 600; }
        .engine-settings .es-pill.ok { background: rgba(31,111,92,0.14); color: #1f6f5c; }
        .engine-settings .es-pill.bad { background: rgba(192,86,47,0.14); color: #c0562f; }
        .engine-settings .es-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .engine-settings .es-label { font-weight: 600; font-size: 13px; }
        .engine-settings select, .engine-settings input[type='password'] {
          font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(22,32,28,0.2);
          background: #fff; color: #16201c;
        }
        .engine-settings input[type='password'] { width: 100%; }
        .engine-settings .es-tabs { display: inline-flex; border: 1px solid rgba(22,32,28,0.2); border-radius: 8px; overflow: hidden; }
        .engine-settings .es-tab { padding: 7px 14px; background: #fff; border: none; cursor: pointer; font: inherit; }
        .engine-settings .es-tab.on { background: #1f6f5c; color: #fff; }
        .engine-settings .es-note { font-size: 12px; color: #5c6560; }
        .engine-settings .es-slider { display: flex; align-items: center; gap: 0; padding: 6px 0; }
        .engine-settings .es-stop { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; position: relative; }
        .engine-settings .es-stop::before { content: ''; position: absolute; top: 7px; left: -50%; width: 100%; height: 2px; background: rgba(22,32,28,0.18); z-index: 0; }
        .engine-settings .es-stop:first-child::before { display: none; }
        .engine-settings .es-dot { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid rgba(22,32,28,0.3); z-index: 1; }
        .engine-settings .es-stop.on .es-dot { background: #1f6f5c; border-color: #1f6f5c; }
        .engine-settings .es-stop-label { font-size: 11px; color: #5c6560; text-align: center; }
        .engine-settings .es-readout { font-size: 13px; }
        .engine-settings .es-readout strong { color: #16201c; }
        .engine-settings .es-cta {
          align-self: flex-start; margin-top: 4px; padding: 9px 16px; border-radius: 10px; border: none;
          background: #1f6f5c; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
        }
        .engine-settings .es-cta.accent { background: #c0562f; }
        .engine-settings a.es-link { color: #1f6f5c; display: inline-flex; align-items: center; gap: 4px; }
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
