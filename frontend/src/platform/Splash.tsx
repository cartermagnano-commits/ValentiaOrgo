'use client'

import { Beaker } from 'lucide-react'

/**
 * Full-page loading state: the brand mark breathing gently above a
 * short message. Replaces bare "Loading..." text so route transitions
 * feel alive instead of stalled.
 */
export default function Splash({ message = 'Opening Orgo AI…' }: { message?: string }) {
  return (
    <div className="page-loading splash" role="status">
      <span className="brand-mark splash-mark">
        <Beaker size={20} />
      </span>
      <span className="splash-message">{message}</span>
    </div>
  )
}
