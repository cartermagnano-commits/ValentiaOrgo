import { useEffect, useRef, useState } from 'react'
import StructureView from './StructureView'
import { streamNodeExplanation, streamExplanation, streamStereo } from '../api'
import { CheckCircle2, Microscope, Atom } from 'lucide-react'

// 'template' = product came deterministically from a reaction template — the
// name is authoritative, so it gets the high-confidence dot.
const CONF_CLASS = { high: 'conf-high', template: 'conf-high', medium: 'conf-medium', low: 'conf-low', unknown: 'conf-unknown' }

const ROLE_LABEL = { start: 'Starting Material', intermediate: 'Intermediate', product: 'Product' }

// ── Per-node view ─────────────────────────────────────────────────────────────

function NodeInfoView({ nodeData, branch, substrateSMILES }) {
  const [explanation, setExplanation] = useState({ text: '', loading: false, error: null })

  useEffect(() => {
    if (!nodeData || !branch) return
    // Stale flag: switching nodes mid-stream must silence the old stream, or
    // its deltas interleave into the new explanation (and its completion
    // handler can stamp a bogus error over the new stream's pending state).
    let stale = false
    setExplanation({ text: '', loading: true, error: null })
    streamNodeExplanation(nodeData, branch, substrateSMILES, delta => {
      if (!stale) setExplanation(prev => ({ text: prev.text + delta, loading: false, error: null }))
    })
      .then(() => { if (!stale) setExplanation(prev => prev.loading
        ? { text: '', loading: false, error: 'The AI engine returned no response. Check Settings → API key.' }
        : prev) })
      .catch(e => { if (!stale) setExplanation({ text: '', loading: false, error: e.message }) })
    return () => { stale = true }
  }, [nodeData?.smiles, nodeData?.nodeType, branch?.id, substrateSMILES])

  if (!nodeData) return null

  const cls = branch?.reaction_classification ?? { name: 'Unknown', confidence: 'unknown' }
  const role = ROLE_LABEL[nodeData.nodeType] ?? nodeData.nodeType

  return (
    <div className="panel-body">

      {/* Step role badge */}
      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Selected Step</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            background: nodeData.nodeType === 'start'
              ? 'rgba(188,140,255,0.15)' : nodeData.nodeType === 'product'
              ? 'rgba(63,185,80,0.15)' : 'rgba(88,166,255,0.12)',
            color: nodeData.nodeType === 'start'
              ? 'var(--accent2)' : nodeData.nodeType === 'product'
              ? 'var(--success)' : 'var(--accent)',
            border: `1px solid ${nodeData.nodeType === 'start'
              ? 'rgba(188,140,255,0.35)' : nodeData.nodeType === 'product'
              ? 'rgba(63,185,80,0.35)' : 'rgba(88,166,255,0.3)'}`,
            borderRadius: 20,
            padding: '3px 12px',
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}>
            {role}
          </span>
          {nodeData.stepIndex > 0 && (
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>step {nodeData.stepIndex}</span>
          )}
        </div>
      </div>

      {/* Structure */}
      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Structure</div>
        <div className="product-structure-preview">
          <StructureView smiles={nodeData.smiles} width={300} height={130} />
        </div>
        <div style={{
          marginTop: 6, fontFamily: 'SFMono-Regular, Consolas, monospace',
          fontSize: 10, color: 'var(--muted)', wordBreak: 'break-all', lineHeight: 1.4,
        }}>
          {nodeData.smiles}
        </div>
      </div>

      {/* Reaction classification (shown for non-start nodes) */}
      {nodeData.nodeType !== 'start' && branch && (
        <div>
          <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Reaction</div>
          <div className="rxn-name-badge">
            <span className={`confidence-dot ${CONF_CLASS[cls.confidence] ?? 'conf-unknown'}`} />
            {cls.name}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
            {nodeData.reagentName && `Reagent: ${nodeData.reagentName}`}
            {nodeData.environment && ` · ${nodeData.environment} control`}
          </div>
        </div>
      )}

      {/* Step text from engine */}
      {nodeData.stepText && nodeData.stepText !== 'Starting material' && (
        <div>
          <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>Engine step</div>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 10px', fontSize: 11,
            color: 'var(--muted)', lineHeight: 1.5, fontFamily: 'SFMono-Regular, Consolas, monospace',
          }}>
            {nodeData.stepText}
          </div>
        </div>
      )}

      {/* LLM explanation */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>
          Step explanation
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>(AI)</span>
        </div>
        <div className="explanation-box">
          {explanation.loading ? (
            <div className="loading-row">
              <div className="spinner" /> Generating explanation…
            </div>
          ) : explanation.error ? (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>{explanation.error}</span>
          ) : explanation.text ? (
            explanation.text
          ) : (
            <span className="explanation-placeholder">Explanation will appear here.</span>
          )}
        </div>
      </div>

    </div>
  )
}

// ── Branch-level view (default when no node selected) ─────────────────────────

function BranchInfoView({ branch, substrateSMILES }) {
  const [explanation, setExplanation] = useState({ text: '', loading: false, error: null })
  const [stereo, setStereo] = useState({ text: '', loading: false, error: null, requested: false })
  // Bumped whenever the branch changes so an in-flight stereo stream from the
  // previous branch can't write into the freshly-reset stereo state.
  const stereoSeq = useRef(0)

  useEffect(() => {
    if (!branch) return
    // Stale flag: switching branches mid-stream must silence the old stream —
    // see NodeInfoView for the failure modes.
    let stale = false
    stereoSeq.current++
    setExplanation({ text: '', loading: true, error: null })
    setStereo({ text: '', loading: false, error: null, requested: false })
    streamExplanation(branch, substrateSMILES, delta => {
      if (!stale) setExplanation(prev => ({ text: prev.text + delta, loading: false, error: null }))
    })
      .then(() => { if (!stale) setExplanation(prev => prev.loading
        ? { text: '', loading: false, error: 'The AI engine returned no response. Check Settings → API key.' }
        : prev) })
      .catch(e => { if (!stale) setExplanation({ text: '', loading: false, error: e.message }) })
    return () => { stale = true }
  }, [branch?.id, substrateSMILES])

  function analyzeStereo() {
    const seq = stereoSeq.current
    setStereo({ text: '', loading: true, error: null, requested: true })
    streamStereo(branch, substrateSMILES, delta => {
      if (stereoSeq.current === seq) setStereo(prev => ({ ...prev, text: prev.text + delta, loading: false }))
    })
      .then(() => { if (stereoSeq.current === seq) setStereo(prev => prev.loading
        ? { text: '', loading: false, error: 'The AI engine returned no response. Check Settings → API key.', requested: true }
        : prev) })
      .catch(e => { if (stereoSeq.current === seq) setStereo({ text: '', loading: false, error: e.message, requested: true }) })
  }

  if (!branch) {
    return (
      <div className="panel-body" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
        <Microscope size={38} strokeWidth={1.4} style={{ opacity: 0.28, marginBottom: 10 }} />
        Click a node in the graph or a pathway in the sidebar
      </div>
    )
  }

  const cls = branch.reaction_classification ?? { name: 'Unknown / not yet classified', confidence: 'unknown' }
  const env = branch.environment ?? 'Thermodynamic'

  return (
    <div className="panel-body">

      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Reaction</div>
        <div className="rxn-name-badge">
          <span className={`confidence-dot ${CONF_CLASS[cls.confidence] ?? 'conf-unknown'}`} />
          {cls.name}
        </div>
      </div>

      <div className="card" style={{ padding: '10px 12px' }}>
        <div className="branch-summary">
          <div className="branch-summary-row">
            <span className="branch-summary-label">Reagent</span>
            <span className="branch-summary-value">{branch.reagent?.name ?? '—'}</span>
          </div>
          <div className="branch-summary-row">
            <span className="branch-summary-label">Control</span>
            <span className={`env-badge ${env === 'Kinetic' ? 'env-kinetic' : 'env-thermodynamic'}`}>{env}</span>
          </div>
          <div className="branch-summary-row">
            <span className="branch-summary-label">Steps</span>
            <span className="branch-summary-value">{branch.steps_taken}</span>
          </div>
          {branch.matches_target && (
            <div className="branch-summary-row">
              <span className="branch-summary-label">Target</span>
              <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle2 size={13} />
                Matches your target
              </span>
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Product</div>
        <div className="product-structure-preview">
          <StructureView smiles={branch.product_smiles} width={300} height={130} />
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>
          Mechanism explanation
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>(AI)</span>
        </div>
        <div className="explanation-box">
          {explanation.loading ? (
            <div className="loading-row">
              <div className="spinner" /> Generating explanation…
            </div>
          ) : explanation.error ? (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>{explanation.error}</span>
          ) : explanation.text ? (
            explanation.text
          ) : (
            <span className="explanation-placeholder">Explanation will appear here.</span>
          )}
        </div>
      </div>

      {/* Stereo/regiochemistry — opt-in (extra AI call), since the SMARTS engine
          cannot express stereochemistry on its own. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>
          Stereochemistry &amp; regiochemistry
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>(AI)</span>
        </div>
        {!stereo.requested ? (
          <button
            className="btn-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 0' }}
            onClick={analyzeStereo}
          >
            <Atom size={14} />
            Analyze stereochemistry
          </button>
        ) : (
          <div className="explanation-box">
            {stereo.loading ? (
              <div className="loading-row"><div className="spinner" /> Analyzing stereochemistry…</div>
            ) : stereo.error ? (
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>{stereo.error}</span>
            ) : (
              stereo.text
            )}
          </div>
        )}
      </div>

    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────

// ── DAG node view (target-search / convergent mode) ──────────────────────────

function DAGNodeInfoView({ nodeData, substrateSMILES }) {
  if (!nodeData) return null

  const role = ROLE_LABEL[nodeData.nodeType] ?? nodeData.nodeType
  const isCoupling = nodeData.isCoupling

  return (
    <div className="panel-body">
      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Selected Step</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            background: nodeData.nodeType === 'start'
              ? 'rgba(188,140,255,0.15)' : nodeData.nodeType === 'product'
              ? 'rgba(63,185,80,0.15)' : isCoupling
              ? 'rgba(188,140,255,0.15)' : 'rgba(88,166,255,0.12)',
            color: nodeData.nodeType === 'start'
              ? 'var(--accent2)' : nodeData.nodeType === 'product'
              ? 'var(--success)' : isCoupling
              ? 'var(--accent2)' : 'var(--accent)',
            border: `1px solid ${nodeData.nodeType === 'start'
              ? 'rgba(188,140,255,0.35)' : nodeData.nodeType === 'product'
              ? 'rgba(63,185,80,0.35)' : isCoupling
              ? 'rgba(188,140,255,0.35)' : 'rgba(88,166,255,0.3)'}`,
            borderRadius: 20, padding: '3px 12px', fontSize: 11, fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.07em',
          }}>
            {isCoupling ? 'Coupling step' : role}
          </span>
        </div>
      </div>

      <div>
        <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Structure</div>
        <div className="product-structure-preview">
          <StructureView smiles={nodeData.smiles} width={300} height={130} />
        </div>
        <div style={{
          marginTop: 6, fontFamily: 'SFMono-Regular, Consolas, monospace',
          fontSize: 10, color: 'var(--muted)', wordBreak: 'break-all', lineHeight: 1.4,
        }}>
          {nodeData.smiles}
        </div>
      </div>

      {nodeData.reactionName && (
        <div>
          <div className="panel-header" style={{ padding: '0 0 8px', border: 'none' }}>Reaction</div>
          <div className="rxn-name-badge">
            <span className="confidence-dot conf-high" />
            {nodeData.reactionName}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
            {nodeData.reagentName && `Reagent: ${nodeData.reagentName}`}
            {nodeData.environment && ` · ${nodeData.environment} control`}
            {isCoupling && ' · Convergent coupling'}
          </div>
        </div>
      )}

      {nodeData.stepText && nodeData.stepText !== 'Starting material' && (
        <div>
          <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>Engine step</div>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 10px', fontSize: 11,
            color: 'var(--muted)', lineHeight: 1.5, fontFamily: 'SFMono-Regular, Consolas, monospace',
          }}>
            {nodeData.stepText}
          </div>
        </div>
      )}
    </div>
  )
}

export default function InfoPanel({ branch, route, substrateSMILES, selectedNode, selectedNodeData }) {
  // DAG node selected (target-search mode)
  if (selectedNode && selectedNodeData && selectedNodeData.dagNodeId !== undefined) {
    return <DAGNodeInfoView nodeData={selectedNodeData} substrateSMILES={substrateSMILES} />
  }
  // Branch node selected (fanout mode)
  if (selectedNode && selectedNodeData) {
    return (
      <NodeInfoView
        nodeData={selectedNodeData}
        branch={branch}
        substrateSMILES={substrateSMILES}
      />
    )
  }
  return <BranchInfoView branch={branch} substrateSMILES={substrateSMILES} />
}
