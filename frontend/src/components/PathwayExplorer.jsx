import { useState, useEffect } from 'react'
import MoleculeInput from './MoleculeInput'
import PathwayGraph from './PathwayGraph'
import InfoPanel from './InfoPanel'
import Chatbot from './Chatbot'
import { fetchPathways } from '../api'
import {
  Bot,
  CheckCircle2,
  Info,
  Plus,
  Route,
  X,
} from 'lucide-react'

// ── Loading overlay ───────────────────────────────────────────────────────────

const PATHWAY_MESSAGES = [
  'Inferring reaction conditions…',
  'Exploring reagent pathways…',
  'Validating products…',
  'Building pathway graph…',
]

function LoadingOverlay({ stage }) {
  const messages = stage === 'analyze'
    ? ['Recognizing structure…']
    : PATHWAY_MESSAGES
  const [msgIdx, setMsgIdx] = useState(0)

  useEffect(() => {
    setMsgIdx(0)
    if (messages.length <= 1) return
    const id = setInterval(() => setMsgIdx(i => (i + 1) % messages.length), 2200)
    return () => clearInterval(id)
  }, [stage, messages.length])

  return (
    <div className="loading-overlay">
      <div className="loading-content">
        {/* Atom animation */}
        <div className="atom-wrap">
          <svg viewBox="0 0 120 120" width="110" height="110" aria-hidden="true">
            {/* Nucleus */}
            <circle cx="60" cy="60" r="9" fill="var(--accent2)" opacity="0.9" />
            <circle cx="60" cy="60" r="5" fill="#e6edf3" opacity="0.7" />

            {/* Orbital ring 1 — tilted 0° (flat horizontal ellipse) */}
            <g className="orbit-a">
              <ellipse cx="60" cy="60" rx="48" ry="14"
                fill="none" stroke="var(--accent)" strokeWidth="1.2" strokeOpacity="0.5" />
              <circle cx="108" cy="60" r="5.5" fill="var(--accent)" />
            </g>

            {/* Orbital ring 2 — tilted 60° */}
            <g className="orbit-b">
              <ellipse cx="60" cy="60" rx="48" ry="14"
                fill="none" stroke="var(--accent2)" strokeWidth="1.2" strokeOpacity="0.5" />
              <circle cx="108" cy="60" r="5.5" fill="var(--accent2)" />
            </g>

            {/* Orbital ring 3 — tilted −60° */}
            <g className="orbit-c">
              <ellipse cx="60" cy="60" rx="48" ry="14"
                fill="none" stroke="var(--success)" strokeWidth="1.2" strokeOpacity="0.5" />
              <circle cx="108" cy="60" r="5.5" fill="var(--success)" />
            </g>
          </svg>
        </div>

        {/* Status message */}
        <div className="loading-message" key={msgIdx}>
          {messages[msgIdx]}
        </div>

        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: -4 }}>
          This may take 10–20 seconds
        </div>
      </div>
    </div>
  )
}

// ── Pathway explorer ─────────────────────────────────────────────────────────

const MAX_STARTS = 4

/** @param {{ initialSubstrate?: any, initialTarget?: any, initialPathways?: any, onSave?: any }} [props] */
export default function PathwayExplorer({ initialSubstrate, initialTarget, initialPathways, onSave } = {}) {
  const [startSmilesList,  setStartSmilesList]  = useState(() => initialSubstrate?.length ? initialSubstrate : [''])
  const [targetSmiles,     setTargetSmiles]     = useState(initialTarget ?? '')
  const [desiredDepth,     setDesiredDepth]     = useState(5)
  const [pathwaysData,     setPathwaysData]     = useState(initialPathways ?? null)
  const [selectedRouteId,  setSelectedRouteId]  = useState(null)
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  const [selectedBranchIds, setSelectedBranchIds] = useState([])
  const [selectedNodeId,   setSelectedNodeId]   = useState(null)
  const [selectedNodeData, setSelectedNodeData] = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [loadStage, setLoadStage] = useState('pathways')
  const [error,     setError]     = useState(null)
  const [activeTab, setActiveTab] = useState('info')

  // Helpers to find selected items
  const selectedRoute  = pathwaysData?.routes?.find(r => r.id === selectedRouteId) ?? null
  const selectedBranch = pathwaysData?.branches?.find(b => b.id === selectedBranchId) ?? null

  const nodeBranch = selectedNodeData?.branchId
    ? (pathwaysData?.branches?.find(b => b.id === selectedNodeData.branchId) ?? selectedBranch)
    : selectedBranch

  // Primary substrate for InfoPanel/chatbot context
  const primaryStart = startSmilesList.find(s => s.trim()) ?? ''

  // Restore a default selection when reopening a saved pathway result.
  useEffect(() => {
    if (!pathwaysData) return
    if (pathwaysData.routes?.length) {
      setSelectedRouteId(pathwaysData.routes[0].id)
    } else if (pathwaysData.branches?.length) {
      const match = pathwaysData.branches.find(b => b.matches_target)
      setSelectedBranchId((match ?? pathwaysData.branches[0]).id)
    }
    // Mount-only: restore selection for the initially loaded result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Multiple start inputs ──────────────────────────────────────────────────
  function updateStart(idx, val) {
    setStartSmilesList(prev => prev.map((s, i) => i === idx ? val : s))
  }
  function addStart() {
    if (startSmilesList.length < MAX_STARTS)
      setStartSmilesList(prev => [...prev, ''])
  }
  function removeStart(idx) {
    setStartSmilesList(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)
  }

  // ── Analyze ───────────────────────────────────────────────────────────────
  async function handleAnalyze() {
    const validStarts = startSmilesList.map(s => s.trim()).filter(Boolean)
    if (!validStarts.length) return
    setLoading(true)
    setLoadStage('pathways')
    setError(null)
    setPathwaysData(null)
    setSelectedRouteId(null)
    setSelectedBranchId(null)
    setSelectedBranchIds([])
    setSelectedNodeId(null)
    setSelectedNodeData(null)
    try {
      const data = await fetchPathways(validStarts, targetSmiles.trim(), desiredDepth)
      setPathwaysData(data)
      onSave?.({ startingMaterials: validStarts, targetMolecule: targetSmiles.trim(), pathwaysData: data })
      if (data.routes?.length) {
        setSelectedRouteId(data.routes[0].id)
      } else if (data.branches?.length) {
        const match = data.branches.find(b => b.matches_target)
        setSelectedBranchId((match ?? data.branches[0]).id)
      }
    } catch (e) {
      setError(e.message || 'Failed to compute pathways')
    } finally {
      setLoading(false)
    }
  }

  function handleSelectNode(nodeId, nodeData) {
    setSelectedNodeId(nodeId)
    setSelectedNodeData(nodeData)
  }

  function toggleBranchSelection(branchId) {
    setSelectedNodeId(null)
    setSelectedNodeData(null)
    const next = selectedBranchIds.includes(branchId)
      ? selectedBranchIds.filter(id => id !== branchId)
      : [...selectedBranchIds, branchId]
    setSelectedBranchIds(next)
    setSelectedBranchId(next.includes(branchId) ? branchId : (next[0] ?? branchId))
  }

  function clearBranchSelections() {
    setSelectedBranchIds([])
    setSelectedNodeId(null)
    setSelectedNodeData(null)
  }

  const hasValidStart = startSmilesList.some(s => s.trim())
  const isTargetMode  = pathwaysData?.search_mode === 'target_search'
  const status        = pathwaysData?.result_status

  return (
    <div className="pathway-explorer">
      {loading && <LoadingOverlay stage={loadStage} />}
      <div className="main-content embedded">

        {/* ── Left: inputs ─────────────────────────────────────────── */}
        <div className="panel">
          <div className="panel-header">Structures</div>
          <div className="panel-body">

            {/* Starting materials — one or more */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Starting Material{startSmilesList.length > 1 ? 's' : ''}
                </span>
                {startSmilesList.length < MAX_STARTS && (
                  <button
                    onClick={addStart}
                    title="Add another starting material"
                    className="micro-button"
                  >
                    <Plus size={13} />
                    Add
                  </button>
                )}
              </div>
              {startSmilesList.map((smi, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                  <div style={{ flex: 1 }}>
                    <MoleculeInput
                      label={startSmilesList.length > 1 ? `Material ${idx + 1}` : 'SMILES / image'}
                      value={smi}
                      onChange={val => updateStart(idx, val)}
                    />
                  </div>
                  {startSmilesList.length > 1 && (
                    <button
                      onClick={() => removeStart(idx)}
                      title="Remove"
                      className="icon-button danger"
                      style={{ marginTop: 26 }}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <MoleculeInput
              label="Target Product (optional)"
              value={targetSmiles}
              onChange={setTargetSmiles}
            />

            {/* Depth control — only when a target is set */}
            {targetSmiles.trim() && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Desired depth
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, minWidth: 16, textAlign: 'right' }}>
                    {desiredDepth}
                  </span>
                </div>
                <input
                  type="range" min={1} max={10} step={1} value={desiredDepth}
                  onChange={e => setDesiredDepth(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
                  Preferred route length. Search always continues to depth 10 to find the shortest possible route.
                </div>
              </div>
            )}

            <button
              className="analyze-btn"
              onClick={handleAnalyze}
              disabled={loading || !hasValidStart}
            >
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <span className="spinner" style={{ borderTopColor: '#fff' }} />
                  Computing pathways…
                </span>
              ) : (
                <>
                  <Route size={16} />
                  Analyze Pathways
                </>
              )}
            </button>

            {error && (
              <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--danger)' }}>
                {error}
              </div>
            )}

            {/* Result status summary */}
            {pathwaysData && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  {isTargetMode ? (
                    <>
                      {status === 'found' && (
                        <span style={{ color: 'var(--success)' }}>
                          <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          Target reached in {pathwaysData.shortest_route_depth} step{pathwaysData.shortest_route_depth !== 1 ? 's' : ''}
                        </span>
                      )}
                      {status === 'found_beyond_depth' && (
                        <span style={{ color: '#d2961e' }}>
                          Shortest route: {pathwaysData.shortest_route_depth} steps (exceeds your depth of {pathwaysData.desired_depth})
                        </span>
                      )}
                      {(status === 'not_found' || status === 'ceiling_hit') && (
                        <span style={{ color: 'var(--danger)' }}>Target not reachable</span>
                      )}
                    </>
                  ) : (
                    `${pathwaysData.branches?.length ?? 0} focused pathway${(pathwaysData.branches?.length ?? 0) !== 1 ? 's' : ''} shown`
                  )}
                  {pathwaysData.search_info && (
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                      · {pathwaysData.search_info.nodes_explored} molecules explored
                    </span>
                  )}
                </div>

                {pathwaysData.no_match_message && (
                  <div style={{
                    background: status === 'found_beyond_depth' ? 'rgba(210,153,34,0.08)' : 'rgba(248,81,73,0.08)',
                    border: `1px solid ${status === 'found_beyond_depth' ? 'rgba(210,153,34,0.3)' : 'rgba(248,81,73,0.25)'}`,
                    borderRadius: 6, padding: '8px 10px', fontSize: 11,
                    color: status === 'found_beyond_depth' ? '#d2961e' : 'var(--danger)',
                    lineHeight: 1.5,
                  }}>
                    {pathwaysData.no_match_message}
                  </div>
                )}
              </div>
            )}

            {/* Route list (target-search mode) */}
            {isTargetMode && pathwaysData.routes?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="panel-header" style={{ padding: '4px 0 4px', border: 'none' }}>Routes</div>
                {pathwaysData.routes.map(r => (
                  <button
                    key={r.id}
                    onClick={() => { setSelectedRouteId(r.id); setSelectedNodeId(null); setSelectedNodeData(null) }}
                    style={{
                      background: r.id === selectedRouteId ? 'rgba(63,185,80,0.10)' : 'var(--card)',
                      border: `1px solid ${r.id === selectedRouteId ? 'var(--success)' : 'var(--border)'}`,
                      borderRadius: 6, padding: '8px 10px', textAlign: 'left',
                      cursor: 'pointer', color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--success)' }}>
                        {r.is_shortest ? 'Shortest route' : `Route (${r.depth} steps)`}
                      </span>
                      {r.exceeds_desired_depth && (
                        <span style={{ fontSize: 10, color: '#d2961e', background: 'rgba(210,153,34,0.12)',
                          border: '1px solid rgba(210,153,34,0.3)', borderRadius: 20, padding: '1px 7px' }}>
                          exceeds depth
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {r.depth} step{r.depth !== 1 ? 's' : ''} ·{' '}
                      {r.dag_nodes?.filter(n => n.is_coupling).length > 0
                        ? `${r.dag_nodes.filter(n => n.is_coupling).length} coupling step(s)`
                        : 'linear route'}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Branch list (fanout mode) */}
            {!isTargetMode && pathwaysData?.branches?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="pathway-list-header">
                  <div className="panel-header" style={{ padding: '4px 0 4px', border: 'none' }}>
                    Focused pathways
                  </div>
                  {selectedBranchIds.length > 0 && (
                    <button
                      className="micro-button"
                      onClick={clearBranchSelections}
                      title="Show all pathways"
                    >
                      <X size={12} />
                      Show all
                    </button>
                  )}
                </div>
                {selectedBranchIds.length > 0 && (
                  <div className="selection-summary">
                    Showing {selectedBranchIds.length} of {pathwaysData.branches.length} pathways
                  </div>
                )}
                {pathwaysData.branches.map(b => (
                  <button
                    key={b.id}
                    onClick={() => toggleBranchSelection(b.id)}
                    className="pathway-card"
                    style={{
                      background: selectedBranchIds.includes(b.id) ? 'rgba(79,163,209,0.12)' : 'var(--card)',
                      border: `1px solid ${selectedBranchIds.includes(b.id) ? 'var(--accent)' : b.id === selectedBranchId ? 'var(--border-strong)' : 'var(--border)'}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{b.reagent?.name ?? '—'}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {selectedBranchIds.includes(b.id) && (
                          <span className="selection-pill">Selected</span>
                        )}
                        <span className={`env-badge ${b.environment === 'Kinetic' ? 'env-kinetic' : 'env-thermodynamic'}`}>
                          {b.environment}
                        </span>
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {b.reaction_classification?.name ?? 'Unknown reaction'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                      {(b.steps?.length ?? 1) - 1} step{((b.steps?.length ?? 1) - 1) !== 1 ? 's' : ''} ·{' '}
                      {b.steps?.filter(s => s.type === 'intermediate').length > 0
                        ? `${b.steps.filter(s => s.type === 'intermediate').length} intermediate(s)`
                        : 'direct'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Center: pathway graph ─────────────────────────────────── */}
        <div className="panel graph-panel" style={{ border: 'none' }}>
          <div className="panel-header">
            Pathway Graph
            {selectedNodeData && (
              <span style={{ color: 'var(--accent)', marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                · {selectedNodeData.label} selected
              </span>
            )}
          </div>
          <div className="graph-container">
            <PathwayGraph
              data={pathwaysData}
              selectedRouteId={selectedRouteId}
              selectedBranchId={selectedBranchId}
              selectedBranchIds={selectedBranchIds}
              selectedNodeId={selectedNodeId}
              onSelectRoute={setSelectedRouteId}
              onSelectBranch={setSelectedBranchId}
              onSelectNode={handleSelectNode}
            />
          </div>
        </div>

        {/* ── Right: info + chatbot ─────────────────────────────────── */}
        <div className="panel">
          <div className="panel-header" style={{ display: 'flex', gap: 0, padding: 0 }}>
            {['info', 'chat'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`inspector-tab${activeTab === tab ? ' active' : ''}`}
              >
                {tab === 'info' ? <Info size={14} /> : <Bot size={14} />}
                {tab === 'info' ? 'Reaction Info' : 'Assistant'}
              </button>
            ))}
          </div>

          {activeTab === 'info' ? (
            <InfoPanel
              branch={nodeBranch}
              route={selectedRoute}
              substrateSMILES={primaryStart}
              selectedNode={selectedNodeId}
              selectedNodeData={selectedNodeData}
            />
          ) : (
            <Chatbot branch={selectedBranch} substrateSMILES={primaryStart} />
          )}
        </div>

      </div>
    </div>
  )
}
