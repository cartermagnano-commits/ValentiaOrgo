'use client'

import { useEffect, useState } from 'react'
import { WifiOff, CircuitBoard } from 'lucide-react'
import Link from 'next/link'
import { loadPrefs } from '../../lib/engine'

// Polls the FastAPI backend /health (proxied by Next). Shows a fixed banner when
// the chemistry API is unreachable, or when the backend is fine but the engine
// the user selected for AI features has no reachable provider — so AI failures
// are explained before the first panel errors out.
export default function ApiStatusBanner() {
  const [down, setDown] = useState(false)
  const [engineWarning, setEngineWarning] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function check() {
      try {
        const res = await fetch('/health', { cache: 'no-store' })
        if (!active) return
        setDown(!res.ok)
        if (!res.ok) { setEngineWarning(null); return }
        const health = await res.json().catch(() => null)
        if (!active || !health) return
        const prefs = loadPrefs()
        if (prefs.mode === 'local' && health.ollama_running === false) {
          setEngineWarning(
            'Your AI engine is set to Local (Ollama), but Ollama isn’t running. ' +
            'Explanations and chat will fail until you start Ollama or switch engines.'
          )
        } else if (
          prefs.mode === 'hosted' &&
          health.hosted_key_configured === false &&
          health.ollama_running === false
        ) {
          setEngineWarning(
            'Hosted AI isn’t configured on this server and its local fallback (Ollama) ' +
            'isn’t running. Pick a working engine to use explanations and chat.'
          )
        } else {
          setEngineWarning(null)
        }
      } catch {
        if (active) { setDown(true); setEngineWarning(null) }
      }
    }

    check()
    const id = setInterval(check, 20000)
    return () => { active = false; clearInterval(id) }
  }, [])

  if (down) {
    return (
      <div className="api-offline-banner" role="alert">
        <WifiOff size={15} />
        <span>
          Can’t reach the chemistry backend (localhost:8000). Structure recognition,
          pathways, and AI features are unavailable — is the API server running?
        </span>
      </div>
    )
  }

  if (engineWarning) {
    return (
      <div className="api-offline-banner" role="alert">
        <CircuitBoard size={15} />
        <span>
          {engineWarning} <Link href="/settings" style={{ color: 'inherit', textDecoration: 'underline' }}>Settings → Engine</Link>
        </span>
      </div>
    )
  }

  return null
}
