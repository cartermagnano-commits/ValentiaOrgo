import { useState, useEffect, useRef } from 'react'
import { structureUrl } from '../api'

// Module-level render cache. Capped so long sessions with many unique
// structures don't grow memory without bound (Map iterates in insertion
// order, so evicting the first key is FIFO).
const svgCache = new Map()
const SVG_CACHE_MAX = 300

export default function StructureView({ smiles, width = 200, height = 150, className = '' }) {
  const [svg, setSvg] = useState(null)
  const [error, setError] = useState(false)
  const abortRef = useRef(null)

  useEffect(() => {
    if (!smiles) { setSvg(null); setError(false); return }

    const url = structureUrl(smiles, width, height)

    if (svgCache.has(url)) {
      setSvg(svgCache.get(url))
      setError(false)
      return
    }

    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    fetch(url, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error('bad response')
        return r.text()
      })
      .then(text => {
        if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value)
        svgCache.set(url, text)
        setSvg(text)
        setError(false)
      })
      .catch(e => {
        if (e.name !== 'AbortError') setError(true)
      })

    return () => ctrl.abort()
  }, [smiles, width, height])

  if (!smiles) return null

  if (error) {
    return (
      <div className={`structure-error ${className}`} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#8b949e', fontSize: 11, background: '#f8f9fa',
        width, height, borderRadius: 4,
      }}>
        Invalid structure
      </div>
    )
  }

  if (!svg) {
    return (
      <div style={{ width, height, background: '#f3f4f6', borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" />
      </div>
    )
  }

  return (
    <div
      className={`structure-view structure-outline ${className}`.trim()}
      style={{ width, height, overflow: 'hidden', background: '#fff', borderRadius: 4 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
