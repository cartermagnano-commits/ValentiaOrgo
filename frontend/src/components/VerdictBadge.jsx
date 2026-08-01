import { AlertTriangle, BadgeCheck, Bot, HelpCircle } from 'lucide-react'
import StructureView from './StructureView'

const STYLES = {
  verified:   { bg: 'rgba(63,185,80,0.15)',  fg: 'var(--success)', border: 'rgba(63,185,80,0.35)' },
  disputed:   { bg: 'rgba(210,153,34,0.15)', fg: '#d29922',        border: 'rgba(210,153,34,0.35)' },
  ai_only:    { bg: 'rgba(88,166,255,0.15)', fg: '#58a6ff',        border: 'rgba(88,166,255,0.35)' },
  unverified: { bg: 'var(--card)',           fg: 'var(--muted)',   border: 'var(--border)' },
}

const LABELS = {
  verified:   'AI-verified',
  disputed:   'Check result',
  ai_only:    'AI only — not engine-checked',
  unverified: 'Not verified',
}

const ICONS = {
  verified:   BadgeCheck,
  disputed:   AlertTriangle,
  ai_only:    Bot,
  unverified: HelpCircle,
}

function chipStyle(style) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: style.bg, color: style.fg, border: `1px solid ${style.border}`,
    borderRadius: 20, fontSize: 10, fontWeight: 700, padding: '2px 10px',
    whiteSpace: 'nowrap',
  }
}

/** Inline chip showing the joint AI/deterministic verdict. */
export function VerdictBadge({ verdict, loading }) {
  if (loading) {
    return (
      <span style={chipStyle(STYLES.unverified)} title="The AI is independently predicting this reaction">
        <span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} /> Verifying…
      </span>
    )
  }
  if (!verdict) return null
  const style = STYLES[verdict.status] ?? STYLES.unverified
  const Icon = ICONS[verdict.status] ?? HelpCircle
  return (
    <span style={chipStyle(style)} title={verdict.note || ''}>
      <Icon size={11} /> {LABELS[verdict.status] ?? 'Not verified'}
    </span>
  )
}

/** Shown when the engine and the AI never converged: the user decides. */
export function DisputePicker({ verdict, onChoose }) {
  if (!verdict || verdict.status !== 'disputed') return null
  const engine = verdict.engine_products?.[0]
  const ai = verdict.ai_products?.[0]
  if (!engine || !ai) return null
  const rounds = verdict.rounds ?? 1

  const card = (label, smiles, sub, accent) => (
    <div style={{
      flex: 1, minWidth: 200, background: 'var(--card)',
      border: `1px solid ${accent}`, borderRadius: 8, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: accent }}>{label}</div>
      <div style={{ background: '#fff', borderRadius: 6, padding: 6, display: 'flex', justifyContent: 'center' }}>
        <StructureView smiles={smiles} width={220} height={120} />
      </div>
      <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text)' }}>{smiles}</code>
      <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.5 }}>{sub}</div>
      {onChoose && (
        <button className="export-chip" onClick={() => onChoose(smiles)}>Use this product</button>
      )}
    </div>
  )

  return (
    <div style={{
      border: '1px solid rgba(210,153,34,0.35)', background: 'rgba(210,153,34,0.06)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 12, color: '#d29922', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <AlertTriangle size={14} /> The engine and the AI disagree
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        They were re-asked {rounds} time{rounds !== 1 ? 's' : ''} and still
        reached different products. Both are shown — pick the one you judge correct.
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {card('Deterministic engine (SMARTS templates)', engine,
              'Computed by matched reaction templates.', 'var(--success)')}
        {card('AI prediction', ai,
              'Predicted by the AI; no template produced it.', '#58a6ff')}
      </div>
    </div>
  )
}

/** Template miss: the AI answered where the engine could not. */
export function AiOnlyCard({ verdict }) {
  if (!verdict || verdict.status !== 'ai_only' || !verdict.agreed_product) return null
  const smiles = verdict.agreed_product
  return (
    <div style={{
      border: '1px solid rgba(88,166,255,0.35)', background: 'rgba(88,166,255,0.06)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 12, color: '#58a6ff', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Bot size={14} /> AI prediction — not checked by the deterministic engine
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        No reaction template matched this substrate and reagent, so the engine could not
        compute a product. The structure below is the AI&apos;s prediction alone. Treat it as a
        starting point, not a verified result.
      </div>
      <div style={{ background: '#fff', borderRadius: 6, padding: 8, display: 'flex', justifyContent: 'center' }}>
        <StructureView smiles={smiles} width={280} height={150} />
      </div>
      <code style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text)' }}>{smiles}</code>
    </div>
  )
}
