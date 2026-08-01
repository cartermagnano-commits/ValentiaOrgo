import { useRef, useState } from 'react'
import MoleculeInput from './MoleculeInput'
import StructureView from './StructureView'
import { AiOnlyCard, DisputePicker, VerdictBadge } from './VerdictBadge'
import { assessReaction, reactDirect } from '../api'
import { downloadMolfile, downloadSvg, copyText, buildReactionReport } from '../../lib/exports'
import { ArrowDown, Check, ChevronRight, Copy, Download, FileText, FlaskConical, Image, Plus } from 'lucide-react'

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

function ProductCard({ product, index }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          background: 'rgba(63,185,80,0.15)', color: 'var(--success)',
          border: '1px solid rgba(63,185,80,0.3)', borderRadius: 20,
          fontSize: 10, fontWeight: 700, padding: '2px 10px',
        }}>
          Product {index + 1}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
          {product.reaction_name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          {product.steps_taken} step{product.steps_taken !== 1 ? 's' : ''}
        </span>
      </div>

      {/* SMILES prominently */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <code style={{
          flex: 1, fontSize: 13, fontWeight: 700,
          background: 'rgba(63,185,80,0.08)', color: 'var(--success)',
          padding: '8px 12px', borderRadius: 6, wordBreak: 'break-all',
          border: '1px solid rgba(63,185,80,0.25)', display: 'block', lineHeight: 1.5,
        }}>{product.smiles}</code>
        <CopyButton text={product.smiles} />
      </div>

      {/* Export */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="export-chip" onClick={() => downloadMolfile(product.smiles, `product_${index + 1}`)} title="Download MDL Molfile">
          <Download size={11} /> .mol
        </button>
        <button className="export-chip" onClick={() => downloadSvg(product.smiles, `product_${index + 1}`)} title="Download SVG image">
          <Image size={11} /> SVG
        </button>
      </div>

      {/* Structure */}
      <div style={{
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, padding: 8,
        display: 'flex', justifyContent: 'center',
      }}>
        <StructureView smiles={product.smiles} width={280} height={160} />
      </div>

      {/* Mechanism */}
      {product.execution_history?.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{
            fontSize: 11, color: 'var(--muted)', cursor: 'pointer',
            userSelect: 'none', listStyle: 'none', display: 'flex',
            alignItems: 'center', gap: 4,
          }}>
            <ChevronRight size={12} />
            Mechanism ({product.execution_history.length} step{product.execution_history.length !== 1 ? 's' : ''})
          </summary>
          <ol style={{ paddingLeft: 18, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {product.execution_history.map((step, i) => (
              <li key={i} style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                {step}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

/** @param {{ initialSubstrate?: any, initialReagent?: any, initialResult?: any, onSave?: any }} [props] */
export default function DirectReact({ initialSubstrate, initialReagent, initialResult, onSave } = {}) {
  const [substrate, setSubstrate] = useState(initialSubstrate ?? '')
  const [reagent,   setReagent]   = useState(initialReagent ?? '')
  const [result,    setResult]    = useState(initialResult ?? null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [verdict,   setVerdict]   = useState(null)
  const [verifying, setVerifying] = useState(false)
  // Bumped per run so a slow verdict from a previous reaction can't land on
  // the current one.
  const assessSeq = useRef(0)

  const canRun = substrate.trim() && reagent.trim() && !loading

  async function handleRun() {
    if (!canRun) return
    setLoading(true)
    setError(null)
    setResult(null)
    setVerdict(null)
    const seq = ++assessSeq.current
    try {
      const data = await reactDirect(substrate.trim(), reagent.trim())
      setResult(data)
      onSave?.({
        reactants: [substrate.trim()],
        reagents: reagent.trim(),
        predictedProducts: data.products?.map(p => p.smiles) ?? [],
        result: data,
      })
      // The engine has answered; now let the AI weigh in alongside it. A
      // template miss still gets assessed — that's the AI-only path.
      setVerifying(true)
      assessReaction(substrate.trim(), reagent.trim(), data.products?.map(p => p.smiles) ?? [])
        .then(v => { if (assessSeq.current === seq) setVerdict(v) })
        .catch(() => { /* verification is best-effort; engine result stands */ })
        .finally(() => { if (assessSeq.current === seq) setVerifying(false) })
    } catch (e) {
      setError(e.message || 'Reaction failed')
    } finally {
      setLoading(false)
    }
  }

  function handleClear() {
    assessSeq.current++
    setSubstrate('')
    setReagent('')
    setResult(null)
    setError(null)
    setVerdict(null)
    setVerifying(false)
  }

  return (
    <div style={{
      maxWidth: 800, margin: '0 auto', padding: '28px 20px',
      display: 'flex', flexDirection: 'column', gap: 20,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
          Direct Reaction
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          Enter or upload each molecule separately, then click Run Reaction to predict products.
        </div>
      </div>

      {/* Molecule inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'start' }}>
        <MoleculeInput
          label="Substrate"
          value={substrate}
          onChange={setSubstrate}
        />

        {/* Arrow */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          paddingTop: 60, color: 'var(--muted)', fontSize: 22, userSelect: 'none',
        }}>
          <Plus size={20} strokeWidth={1.8} />
        </div>

        <MoleculeInput
          label="Reagent"
          value={reagent}
          onChange={setReagent}
        />
      </div>

      {/* Run button */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          onClick={handleRun}
          disabled={!canRun}
          style={{
            background: canRun ? 'var(--accent)' : 'var(--card)',
            color: canRun ? '#fff' : 'var(--muted)',
            border: `1px solid ${canRun ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8, fontSize: 14, fontWeight: 700,
            padding: '10px 28px', cursor: canRun ? 'pointer' : 'default',
            transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {loading ? (
            <><span className="spinner" style={{ borderTopColor: '#fff' }} /> Running…</>
          ) : (
            <><FlaskConical size={16} /> Run Reaction</>
          )}
        </button>

        {(substrate || reagent || result) && (
          <button
            onClick={handleClear}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--muted)', fontSize: 12, padding: '10px 16px', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--danger)',
        }}>
          {error}
        </div>
      )}

      {/* Results */}
      {result && !loading && result.products?.length > 0 && (
        <div>
          {/* Arrow divider */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginBottom: 16, color: 'var(--muted)',
          }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <ArrowDown size={18} />
            <span style={{
              fontSize: 11, fontWeight: 600, color: 'var(--success)',
              textTransform: 'uppercase', letterSpacing: '0.08em',
            }}>
              {result.products.length} predicted product{result.products.length !== 1 ? 's' : ''}
            </span>
            <span style={{ fontSize: 10, color: 'var(--muted)', background: 'var(--card)',
              border: '1px solid var(--border)', borderRadius: 20, padding: '1px 8px' }}>
              {result.environment}
            </span>
            <VerdictBadge verdict={verdict} loading={verifying} />
            <button
              className="export-chip"
              onClick={() => copyText(buildReactionReport({
                substrate: substrate.trim(),
                reagent: reagent.trim(),
                environment: result.environment,
                products: result.products,
              }))}
              title="Copy a Markdown reaction report"
            >
              <FileText size={11} /> Copy report
            </button>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {result.products.map((p, i) => (
              <ProductCard key={i} product={p} index={i} />
            ))}
          </div>

          {verdict?.status === 'disputed' && (
            <div style={{ marginTop: 14 }}>
              <DisputePicker verdict={verdict} />
            </div>
          )}
        </div>
      )}

      {/* Template miss: the engine had nothing, so the AI's answer (clearly
          flagged) is better than an empty screen. */}
      {result && !loading && !result.products?.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12, color: 'var(--muted)',
          }}>
            No reaction template matched this pair.
            <VerdictBadge verdict={verdict} loading={verifying} />
          </div>
          <AiOnlyCard verdict={verdict} />
        </div>
      )}
    </div>
  )
}
