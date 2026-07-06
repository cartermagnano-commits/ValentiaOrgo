'use client'

import { useEffect } from 'react'

// Registers the service worker so the app is installable (Add to Home Screen).
export default function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ })
  }, [])
  return null
}
