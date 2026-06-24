import { useEffect, useState } from 'react'
import StructureView from './StructureView'
import { fetchNodeExplanation, fetchExplanation } from '../api'

const CONF_CLASS = { high: 'conf-high', medium: 'conf-medium', low: 'conf-low', unknown: 'conf-unknown' }

const ROLE_LABEL = { start: 'Starting Material', intermediate: 'Intermediate', product: 'Product' }

// ── Per-node view ─────────────────────────────────────────────────────────────

function NodeInfoView({ nodeData, branch, substrateSMILES }) {
  const [explanation, setExplanation] = useState({ text: '', loading: false, error: null })

  useEffect(() => {
    if (!nodeData || !branch) return
    setExplanation({ text: '', loading: true, error: null })
    fetchNodeExplanation(nodeData, branch, substrateSMILES)
      .then(r => setExplanation({ text: r.explanation, loading: false, error: null }))
      .catch(e => setExplanation({ text: '', loading: false, error: e.message }))
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

  useEffect(() => {
    if (!branch) return
    setExplanation({ text: '', loading: true, error: null })
    fetchExplanation(branch, substrateSMILES)
      .then(r => setExplanation({ text: r.explanation, loading: false, error: null }))
      .catch(e => setExplanation({ text: '', loading: false, error: e.message }))
  }, [branch?.id, substrateSMILES])

  if (!branch) {
    return (
      <div className="panel-body" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
        <div style={{ fontSize: 36, opacity: 0.2, marginBottom: 10 }}>🔬</div>
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
            <span className="branch-summary-value">{branch.reagent.name}</span>
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
              <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 12 }}>✓ Matches your target</span>
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

    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function InfoPanel({ branch, substrateSMILES, selectedNode, selectedNodeData }) {
  if (selectedNode && selectedNodeData) {
    const nodeBranch = branch  // branch is already the one matching selectedNode's branchId
    return (
      <NodeInfoView
        nodeData={selectedNodeData}
        branch={nodeBranch}
        substrateSMILES={substrateSMILES}
      />
    )
  }
  return <BranchInfoView branch={branch} substrateSMILES={substrateSMILES} />
}
