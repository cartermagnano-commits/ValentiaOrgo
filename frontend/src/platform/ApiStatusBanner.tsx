'use client'

import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'

// Polls the FastAPI backend /health (proxied by Next). Shows a fixed banner when
// the chemistry API is unreachable so users understand why recognition/pathways/
// AI features aren't responding.
export default function ApiStatusBanner() {
  const [down, setDown] = useState(false)

  useEffect(() => {
    let active = true

    async function check() {
      try {
        const res = await fetch('/health', { cache: 'no-store' })
        if (active) setDown(!res.ok)
      } catch {
        if (active) setDown(true)
      }
    }

    check()
    const id = setInterval(check, 20000)
    return () => { active = false; clearInterval(id) }
  }, [])

  if (!down) return null

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
