import { useRef, useState } from 'react'
import StructureView from './StructureView'
import { reactFromImage } from '../api'
import { ArrowLeft, Camera, Check, Copy, X } from 'lucide-react'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      onClick={copy}
      title="Copy SMILES"
      style={{
        background: 'none', border: '1px solid var(--border)', borderRadius: 4,
        color: copied ? 'var(--success)' : 'var(--muted)', fontSize: 10,
        padding: '2px 7px', cursor: 'pointer', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
    </button>
  )
}

function SmilesPill({ label, smiles, color = 'var(--accent)' }) {
  if (!smiles) return null
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase',
        letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <code style={{
          flex: 1, fontSize: 11, background: 'var(--surface)', color: 'var(--text)',
          padding: '4px 8px', borderRadius: 4, wordBreak: 'break-all',
          border: '1px solid var(--border)', display: 'block',
        }}>{smiles}</code>
        <CopyButton text={smiles} />
      </div>
      <StructureView smiles={smiles} width={240} height={130} />
    </div>
  )
}

function ProductCard({ product, index }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          background: 'rgba(63,185,80,0.15)', color: 'var(--success)',
          border: '1px solid rgba(63,185,80,0.3)', borderRadius: 20,
          fontSize: 10, fontWeight: 700, padding: '2px 8px',
        }}>
          Product {index + 1}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
          {product.reaction_name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          {product.steps_taken} step{product.steps_taken !== 1 ? 's' : ''}
        </span>
      </div>

      {/* SMILES prominently */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <code style={{
          flex: 1, fontSize: 12, fontWeight: 600,
          background: 'rgba(63,185,80,0.08)', color: 'var(--success)',
          padding: '6px 10px', borderRadius: 6, wordBreak: 'break-all',
          border: '1px solid rgba(63,185,80,0.25)', display: 'block',
        }}>{product.smiles}</code>
        <CopyButton text={product.smiles} />
      </div>

      {/* Structure */}
      <div style={{
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: 6,
        display: 'flex', justifyContent: 'center',
      }}>
        <StructureView smiles={product.smiles} width={260} height={150} />
      </div>

      {/* Mechanism steps */}
      {product.execution_history?.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 10, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
            Mechanism ({product.execution_history.length} step{product.execution_history.length !== 1 ? 's' : ''})
          </summary>
          <ol style={{ paddingLeft: 16, marginTop: 6 }}>
            {product.execution_history.map((step, i) => (
              <li key={i} style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2, lineHeight: 1.5 }}>
                {step}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

/** @param {{ initialResult?: any, onSave?: any }} [props] */
export default function ReactPredict({ initialResult, onSave } = {}) {
  const [result, setResult]   = useState(initialResult ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [preview, setPreview] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  async function handleFile(file) {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)
    setPreview(URL.createObjectURL(file))
    try {
      const data = await reactFromImage(file)
      setResult(data)
      if (data.products?.length) {
        onSave?.({
          predictedMajorProduct: data.products[0]?.smiles ?? '',
          sideProducts: data.products.slice(1).map(p => p.smiles),
          result: data,
        })
      }
      if (data.error && !data.products?.length) {
        setError(data.error)
      }
    } catch (e) {
      setError(e.message || 'Pipeline failed')
    } finally {
      setLoading(false)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function onDragOver(e) {
    e.preventDefault()
    setDragOver(true)
  }

  function reset() {
    setResult(null)
    setError(null)
    setPreview(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div style={{
      maxWidth: 720, margin: '0 auto', padding: '28px 20px',
      display: 'flex', flexDirection: 'column', gap: 20,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
          Predict from Photo
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          Upload or capture a structural drawing containing your reactants. The pipeline will
          recognize the structures, identify the substrate and reagent, and predict the
          products in SMILES format.
        </div>
      </div>

      {/* Upload area */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onClick={() => !loading && fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 10,
          background: dragOver ? 'rgba(88,166,255,0.05)' : 'var(--card)',
          padding: 24, textAlign: 'center', cursor: loading ? 'default' : 'pointer',
          transition: 'border-color 0.15s, background 0.15s',
          position: 'relative', minHeight: 140,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10,
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files[0])}
        />

        {loading ? (
          <>
            <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Recognizing structures and predicting products…
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              This may take 15–30 seconds
            </div>
          </>
        ) : preview ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <img
              src={preview}
              alt="Uploaded reactants"
              style={{ maxHeight: 180, maxWidth: '100%', borderRadius: 6, objectFit: 'contain' }}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Click to upload a different image
            </div>
          </div>
        ) : (
          <>
            <Camera size={38} strokeWidth={1.45} style={{ opacity: 0.55 }} />
            <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
              Drop an image here or click to upload
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Supports structural drawings with substrate + reagent
            </div>
          </>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--danger)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{error}</span>
          <button onClick={reset} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', lineHeight: 1, display: 'inline-flex', padding: 3,
          }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Recognized SMILES */}
          {result.recognized_smiles && (
            <div style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 14px',
            }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                Recognized SMILES
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{
                  flex: 1, fontSize: 11, color: 'var(--text)',
                  wordBreak: 'break-all', lineHeight: 1.5,
                }}>{result.recognized_smiles}</code>
                <CopyButton text={result.recognized_smiles} />
              </div>
            </div>
          )}

          {/* Reactant breakdown */}
          {result.substrate_smiles && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <SmilesPill
                label="Substrate"
                smiles={result.substrate_smiles}
                color="var(--accent)"
              />
              {result.reagent_smiles && (
                <SmilesPill
                  label="Reagent"
                  smiles={result.reagent_smiles}
                  color="var(--accent2)"
                />
              )}
            </div>
          )}

          {/* Products */}
          {result.products?.length > 0 && (
            <div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'var(--success)',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                marginBottom: 10,
              }}>
                {result.products.length} Predicted Product{result.products.length !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {result.products.map((p, i) => (
                  <ProductCard key={i} product={p} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Soft error when products empty but reactants were parsed */}
          {result.products?.length === 0 && result.substrate_smiles && (
            <div style={{
              background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.25)',
              borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--danger)',
            }}>
              {result.error || 'No reaction templates matched this substrate/reagent pair.'}
            </div>
          )}

          <button
            onClick={reset}
            style={{
              alignSelf: 'flex-start',
              background: 'none', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--muted)', fontSize: 12,
              padding: '6px 14px', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <ArrowLeft size={14} />
            New prediction
          </button>
        </div>
      )}
    </div>
  )
}
