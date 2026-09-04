'use client'

import { useEffect, useState } from 'react'
import { Download, ShieldCheck, Trash2 } from 'lucide-react'
import { STRENGTH, loadApiKey, loadPreferredModel, saveApiKey, savePreferredModel } from '../../lib/engine'
import type { Project, Session } from '../../lib/sessions'

export default function SettingsPage({
  sessions,
  projects,
  onClearAll,
}: {
  sessions: Session[]
  projects: Project[]
  onClearAll: () => void
}) {
  const [model, setModel] = useState(() => loadPreferredModel())

  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  // localStorage is unavailable during SSR, so read it after mount.
  useEffect(() => { setApiKey(loadApiKey()) }, [])

  function commitKey(next: string) {
    setApiKey(next)
    saveApiKey(next)
    setKeySaved(true)
    window.setTimeout(() => setKeySaved(false), 1800)
  }

  function pick(next: string) {
    setModel(next)
    savePreferredModel(next)
  }

  // Everything lives in localStorage, so an export is just the store itself —
  // enough to move a browser or keep a backup.
  function exportAll() {
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), projects, sessions }, null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `orgo-ai-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
      </div>

      <section className="settings-section">
        <h2>API key</h2>
        <p className="settings-blurb">
          AI features — explanations, chat, and reading structures from photos —
          run on your own key. Paste an MIT Parley key (<code>sk-parley-…</code>)
          or an Anthropic key; we route it to the right place automatically.
        </p>
        <div className="settings-row">
          <input
            type="password"
            className="settings-input"
            value={apiKey}
            placeholder="sk-parley-…"
            autoComplete="off"
            spellCheck={false}
            onChange={e => setApiKey(e.target.value)}
            onBlur={e => commitKey(e.target.value)}
            aria-label="Your API key"
          />
          <button className="btn-quiet" onClick={() => commitKey(apiKey)}>
            Save
          </button>
        </div>
        <div className="settings-note">
          <p>
            {keySaved
              ? 'Saved.'
              : apiKey
                ? 'Stored in this browser only. Sent with each request, never saved on our server.'
                : 'Without a key, drawing structures and predicting reactions still work — they run on the deterministic engine, no AI needed.'}
          </p>
        </div>
      </section>

      <section className="settings-section">
        <h2>Default model</h2>
        <p className="settings-blurb">
          Which Claude model new conversations start on. You can still switch model
          per message from the composer.
        </p>
        <div className="model-options">
          {STRENGTH.anthropic.map(stop => (
            <button
              key={stop.model}
              className={`model-option${model === stop.model ? ' active' : ''}`}
              aria-pressed={model === stop.model}
              onClick={() => pick(stop.model)}
            >
              <strong>{stop.label}</strong>
              <span>{stop.cost}</span>
              <code>{stop.model}</code>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>Your data</h2>
        <p className="settings-blurb">
          {sessions.length} {sessions.length === 1 ? 'chat' : 'chats'} and {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'} are stored in this browser only —
          there are no accounts and nothing syncs. Clearing browser data clears these too.
        </p>
        <div className="settings-row">
          <button className="btn-quiet" onClick={exportAll}>
            <Download size={15} />
            Export everything (JSON)
          </button>
          <button className="btn-danger" onClick={onClearAll}>
            <Trash2 size={15} />
            Delete all chats &amp; projects
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>How the chemistry works</h2>
        <div className="settings-note">
          <ShieldCheck size={16} />
          <p>
            Products come from a deterministic RDKit template engine, and every structure is
            validated before it reaches you. The model only explains, annotates and converses
            over that output — it never invents a reaction. Where no template matches, the app
            says so explicitly and labels any AI suggestion as unverified.
          </p>
        </div>
      </section>
    </div>
  )
}
