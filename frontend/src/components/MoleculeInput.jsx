import { useRef, useState } from 'react'
import StructureView from './StructureView'
import { analyzeImage } from '../api'

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
  const fileRef = useRef(null)

  async function handleFile(file) {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const result = await analyzeImage(file)
      if (result.smiles) {
        onChange(result.smiles)
        setShowSmiles(true)
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

  const hint = isSmallHydrocarbon(value)

  return (
    <div className="card mol-input-card">
      <div className="card-title" style={{ paddingBottom: 8 }}>{label}</div>

      {/* Structure display — clickable to trigger upload */}
      <div
        className={`mol-structure-area${value ? '' : ' empty'}`}
        style={{ height: 140 }}
        onClick={() => !value && fileRef.current?.click()}
        title={value ? undefined : 'Click to upload or capture image'}
      >
        {loading ? (
          <>
            <div className="spinner" />
            <span style={{ fontSize: 11, marginTop: 6, color: '#8b949e' }}>Recognizing…</span>
          </>
        ) : value ? (
          <StructureView smiles={value} width={200} height={136} />
        ) : (
          <>
            <span className="upload-icon">⬆</span>
            <span>Upload or capture image</span>
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
            style={{ display: 'block', textAlign: 'center', cursor: 'pointer', padding: '6px 0' }}
          >
            📷 Camera / File
          </span>
        </label>
        <button
          className="btn-icon"
          title={showSmiles ? 'Hide SMILES' : 'Edit SMILES'}
          onClick={() => setShowSmiles(s => !s)}
        >
          {showSmiles ? '▲' : 'SMILES'}
        </button>
        {value && (
          <button className="btn-icon" title="Clear" onClick={() => { onChange(''); setShowSmiles(false) }}>
            ✕
          </button>
        )}
      </div>

      {/* Editable SMILES — shown when toggled or after recognition */}
      {showSmiles && (
        <div className="mol-smiles-row">
          <span className="smiles-label">SMILES (editable)</span>
          <textarea
            className="smiles-input"
            rows={2}
            value={value}
            placeholder="e.g. CC(=O)CCBr"
            onChange={e => onChange(e.target.value)}
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
