import { useEffect, useRef, useState } from 'react'
import StructureView from './StructureView'
import { analyzeImage } from '../api'
import { imageFileFromClipboard, pasteTargetIsEditable, readImageFromClipboard } from '../../lib/clipboard'
import { Camera, ChevronUp, ClipboardPaste, Eye, Pencil, UploadCloud, X, ShieldCheck, AlertTriangle } from 'lucide-react'

// Page-level paste routing: when the user hits Ctrl+V without having clicked
// into a specific card (e.g. right after taking a screen snip), the image goes
// to the first mounted MoleculeInput that doesn't have a structure yet.
// Card-level onPaste handlers preventDefault first, so a paste aimed at a
// specific card never double-fires here.
const _pasteTargets = []
if (typeof window !== 'undefined') {
  window.addEventListener('paste', e => {
    if (e.defaultPrevented || pasteTargetIsEditable(e)) return
    const file = imageFileFromClipboard(e)
    if (!file) return
    const target = _pasteTargets.find(t => t.isEmpty()) ?? _pasteTargets[0]
    if (target) {
      e.preventDefault()
      target.handle(file)
    }
  })
}

const STAGE_LABELS = {
  original: 'Original',
  perspective: 'Perspective',
  deskew: 'Deskew',
  denoise: 'Denoise',
  binarize: 'Binarized',
}

function isSmallHydrocarbon(smiles) {
  if (!smiles) return false
  // Check for any heteroatoms (N, O, F, P, S, Br, Cl, I beyond halide context)
  if (/[NOFPS]|Br/.test(smiles)) return false
  // Cl counts as halide — if substrate has Cl it's not a plain hydrocarbon
  if (/Cl/.test(smiles)) return false
  // Count carbons (C and c, excluding Cl)
  const stripped = smiles.replace(/Cl/g, '')
  const carbons = (stripped.match(/[Cc]/g) || []).length
  return carbons > 0 && carbons < 4
}

export default function MoleculeInput({ label, value, onChange }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)
  const [showSmiles, setShowSmiles] = useState(false)
  const [confidence, setConfidence] = useState(null)  // 'high' | 'low' | 'unverified' | null
  const [stages, setStages] = useState(null)          // { original, ..., binarize } base64 PNGs
  const [showStages, setShowStages] = useState(false)
  const fileRef = useRef(null)

  // Register with the page-level paste router (see top of file). Refs keep the
  // registry entry stable while always seeing the latest value/handler.
  const valueRef = useRef(value)
  valueRef.current = value
  const handleFileRef = useRef(null)

  useEffect(() => {
    const entry = {
      isEmpty: () => !(valueRef.current ?? '').trim(),
      handle: file => handleFileRef.current?.(file),
    }
    _pasteTargets.push(entry)
    return () => {
      const i = _pasteTargets.indexOf(entry)
      if (i >= 0) _pasteTargets.splice(i, 1)
    }
  }, [])

  function onCardPaste(e) {
    const file = imageFileFromClipboard(e)
    if (file) {
      e.preventDefault()
      handleFile(file)
    }
  }

  async function pasteFromClipboard() {
    setError(null)
    try {
      const file = await readImageFromClipboard()
      if (!file) {
        setError('No image in the clipboard — take a screen snip first (Win+Shift+S).')
        setShowSmiles(true)
        return
      }
      handleFile(file)
    } catch (e) {
      setError(e.message)
      setShowSmiles(true)
    }
  }

  async function handleFile(file) {
    if (!file) return
    setLoading(true)
    setError(null)
    setConfidence(null)
    setStages(null)
    setShowStages(false)
    try {
      const result = await analyzeImage(file)
      setStages(result.stages ?? null)
      if (result.smiles) {
        onChange(result.smiles)
        setConfidence(result.confidence ?? null)
        // Auto-open the stage strip on a doubtful read so the user can compare
        // the recognized structure against what the reader actually saw.
        setShowStages(result.confidence === 'low')
        // Always reveal the editable SMILES when the read isn't confidently verified.
        setShowSmiles(result.confidence !== 'high')
      } else {
        setError('Could not recognize a structure. Please enter SMILES manually.')
        setShowSmiles(true)
      }
    } catch (e) {
      setError(e.message || 'Upload failed')
      setShowSmiles(true)
    } finally {
      setLoading(false)
    }
  }
  handleFileRef.current = handleFile

  const hint = isSmallHydrocarbon(value)

  return (
    <div className="card mol-input-card" onPaste={onCardPaste}>
      <div className="card-title" style={{ paddingBottom: 8 }}>{label}</div>

      {/* Structure display — clickable to trigger upload */}
      <div
        className={`mol-structure-area${value ? '' : ' empty'}`}
        style={{ height: 140 }}
        tabIndex={0}
        onClick={() => !value && fileRef.current?.click()}
        title={value ? undefined : 'Click to upload, or paste an image (Ctrl+V)'}
      >
        {loading ? (
          <>
            <div className="spinner" />
            <span style={{ fontSize: 11, marginTop: 6, color: '#8b949e' }}>Recognizing…</span>
          </>
        ) : value ? (
          <>
            <StructureView smiles={value} width={200} height={136} />
            {confidence === 'high' && (
              <span className="conf-badge ok" title="Verified against your image">
                <ShieldCheck size={12} /> Verified
              </span>
            )}
            {confidence === 'low' && (
              <span className="conf-badge warn" title="Recognition may be wrong — please check">
                <AlertTriangle size={12} /> Check structure
              </span>
            )}
            {confidence === 'unverified' && (
              <span className="conf-badge muted" title="Could not auto-verify (vision model unavailable)">
                <AlertTriangle size={12} /> Unverified
              </span>
            )}
          </>
        ) : (
          <>
            <UploadCloud className="upload-icon" size={30} strokeWidth={1.6} />
            <span>Upload, capture, or paste image</span>
            <span style={{ fontSize: 10, color: 'var(--subtle)' }}>Ctrl+V a screen snip works</span>
          </>
        )}
      </div>

      {/* Actions row */}
      <div className="mol-actions">
        <label style={{ flex: 1 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
          <span
            className="btn-secondary"
            style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 0' }}
          >
            <Camera size={14} />
            Camera / File
          </span>
        </label>
        <button
          className="btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}
          title="Paste an image from your clipboard"
          onClick={pasteFromClipboard}
          disabled={loading}
        >
          <ClipboardPaste size={14} />
          Paste
        </button>
        <button
          className="btn-icon"
          title={showSmiles ? 'Hide SMILES' : 'Edit SMILES'}
          onClick={() => setShowSmiles(s => !s)}
        >
          {showSmiles ? <ChevronUp size={14} /> : <><Pencil size={13} /> SMILES</>}
        </button>
        {stages && (
          <button
            className={`btn-icon${showStages ? ' active' : ''}`}
            title="See what the structure reader saw at each preprocessing step"
            onClick={() => setShowStages(s => !s)}
          >
            <Eye size={14} />
          </button>
        )}
        {value && (
          <button className="btn-icon" title="Clear" onClick={() => { onChange(''); setShowSmiles(false); setConfidence(null); setStages(null); setShowStages(false) }}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* Preprocessing stage strip — what the OSR reader actually saw */}
      {showStages && stages && (
        <div className="stage-strip">
          {Object.entries(STAGE_LABELS)
            .filter(([key]) => stages[key])
            .map(([key, label]) => (
              <figure key={key} className="stage-thumb">
                <img src={`data:image/png;base64,${stages[key]}`} alt={label} loading="lazy" />
                <figcaption>{label}</figcaption>
              </figure>
            ))}
        </div>
      )}

      {/* Editable SMILES — shown when toggled or after recognition */}
      {showSmiles && (
        <div className="mol-smiles-row">
          {confidence === 'low' && (
            <div className="hint-banner" style={{ margin: '0 0 6px' }}>
              The automatic reader wasn’t confident this matches your image. Please verify or
              correct the SMILES below before continuing.
            </div>
          )}
          <span className="smiles-label">SMILES (editable)</span>
          <textarea
            className="smiles-input"
            rows={2}
            value={value}
            placeholder="e.g. CC(=O)CCBr"
            onChange={e => { onChange(e.target.value); setConfidence(null) }}
            spellCheck={false}
          />
          {error && (
            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>{error}</div>
          )}
        </div>
      )}

      {/* 4-carbon hint */}
      {hint && (
        <div className="hint-banner" style={{ margin: '0 10px 10px' }}>
          This looks like a small hydrocarbon (&lt; 4 carbons). Most interesting orgo reactions
          need a larger substrate — consider a longer chain or adding a functional group.
        </div>
      )}
    </div>
  )
}
