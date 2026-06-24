import { useState, useEffect } from 'react'
import MoleculeInput from './components/MoleculeInput'
import PathwayGraph from './components/PathwayGraph'
import InfoPanel from './components/InfoPanel'
import Chatbot from './components/Chatbot'
import { fetchPathways } from './api'

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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [startSmiles,    setStartSmiles]    = useState('')
  const [targetSmiles,   setTargetSmiles]   = useState('')
  const [maxDepth,       setMaxDepth]       = useState(5)
  const [pathwaysData,   setPathwaysData]   = useState(null)
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  const [selectedNodeId,   setSelectedNodeId]   = useState(null)
  const [selectedNodeData, setSelectedNodeData] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [loadStage, setLoadStage] = useState('pathways')
  const [error,    setError]    = useState(null)
  const [activeTab, setActiveTab] = useState('info')

  const selectedBranch = pathwaysData?.branches?.find(b => b.id === selectedBranchId) ?? null

  // If selected node belongs to a different branch than what's selected, find the right one
  const nodeBranch = selectedNodeData?.branchId
    ? (pathwaysData?.branches?.find(b => b.id === selectedNodeData.branchId) ?? selectedBranch)
    : selectedBranch

  async function handleAnalyze() {
    if (!startSmiles.trim()) return
    setLoading(true)
    setLoadStage('pathways')
    setError(null)
    setPathwaysData(null)
    setSelectedBranchId(null)
    setSelectedNodeId(null)
    setSelectedNodeData(null)
    try {
      const data = await fetchPathways(startSmiles.trim(), targetSmiles.trim(), maxDepth)
      setPathwaysData(data)
      if (data.branches?.length) {
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

  return (
    <div className="app">
      {loading && <LoadingOverlay stage={loadStage} />}

      <header>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <circle cx="14" cy="14" r="13" stroke="#58a6ff" strokeWidth="1.5"/>
          <circle cx="9"  cy="11" r="2.5" fill="#bc8cff"/>
          <circle cx="19" cy="11" r="2.5" fill="#58a6ff"/>
          <circle cx="14" cy="20" r="2.5" fill="#3fb950"/>
          <line x1="9"  y1="11" x2="19" y2="11" stroke="#58a6ff" strokeWidth="1"/>
          <line x1="9"  y1="11" x2="14" y2="20" stroke="#bc8cff" strokeWidth="1"/>
          <line x1="19" y1="11" x2="14" y2="20" stroke="#3fb950" strokeWidth="1"/>
        </svg>
        <div>
          <h1>Orgo AI</h1>
          <div className="subtitle">Reaction pathway explorer</div>
        </div>
      </header>

      <div className="main-content">

        {/* ── Left: inputs ─────────────────────────────────────────── */}
        <div className="panel">
          <div className="panel-header">Structures</div>
          <div className="panel-body">
            <MoleculeInput
              label="Starting Material"
              value={startSmiles}
              onChange={setStartSmiles}
            />
            <MoleculeInput
              label="Target Product (optional)"
              value={targetSmiles}
              onChange={setTargetSmiles}
            />

            {/* Depth control — only meaningful when a target is set */}
            {targetSmiles.trim() && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Search depth
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, minWidth: 16, textAlign: 'right' }}>
                    {maxDepth}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={maxDepth}
                  onChange={e => setMaxDepth(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
                  Max layers of reagents to apply. Deeper = slower and busier graph.
                </div>
              </div>
            )}

            <button
              className="analyze-btn"
              onClick={handleAnalyze}
              disabled={loading || !startSmiles.trim()}
            >
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <span className="spinner" style={{ borderTopColor: '#fff' }} />
                  Computing pathways…
                </span>
              ) : 'Analyze Pathways'}
            </button>

            {error && (
              <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--danger)' }}>
                {error}
              </div>
            )}

            {pathwaysData && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  {pathwaysData.branches.length} pathway{pathwaysData.branches.length !== 1 ? 's' : ''} found
                  {pathwaysData.branches.some(b => b.matches_target) && (
                    <span style={{ color: 'var(--success)', marginLeft: 8 }}>✓ target matched</span>
                  )}
                  {pathwaysData.search_info && (
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                      · {pathwaysData.search_info.nodes_explored} nodes explored
                    </span>
                  )}
                </div>

                {pathwaysData.no_match_message && (
                  <div style={{
                    background: 'rgba(210,153,34,0.08)',
                    border: '1px solid rgba(210,153,34,0.3)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    fontSize: 11,
                    color: '#d2961e',
                    lineHeight: 1.5,
                  }}>
                    {pathwaysData.no_match_message}
                  </div>
                )}
              </div>
            )}

            {/* Branch list */}
            {pathwaysData?.branches?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="panel-header" style={{ padding: '4px 0 4px', border: 'none' }}>
                  Pathways
                </div>
                {pathwaysData.branches.map(b => (
                  <button
                    key={b.id}
                    onClick={() => { setSelectedBranchId(b.id); setSelectedNodeId(null); setSelectedNodeData(null) }}
                    style={{
                      background: b.id === selectedBranchId ? 'rgba(88,166,255,0.12)' : 'var(--card)',
                      border: `1px solid ${b.id === selectedBranchId ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 6,
                      padding: '8px 10px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{b.reagent.name}</span>
                      <span className={`env-badge ${b.environment === 'Kinetic' ? 'env-kinetic' : 'env-thermodynamic'}`}>
                        {b.environment}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {b.reaction_classification?.name ?? 'Unknown reaction'}
                      {b.matches_target && <span style={{ color: 'var(--success)', marginLeft: 6 }}>✓ target</span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                      {b.steps?.length - 1} step{(b.steps?.length - 1) !== 1 ? 's' : ''} ·
                      {b.steps?.filter(s => s.type === 'intermediate').length > 0
                        ? ` ${b.steps.filter(s => s.type === 'intermediate').length} intermediate(s)`
                        : ' direct'}
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
              selectedBranchId={selectedBranchId}
              selectedNodeId={selectedNodeId}
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
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  borderBottom: `2px solid ${activeTab === tab ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 0,
                  color: activeTab === tab ? 'var(--accent)' : 'var(--muted)',
                  padding: '12px 0',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                {tab === 'info' ? 'Reaction Info' : 'Chatbot'}
              </button>
            ))}
          </div>

          {activeTab === 'info' ? (
            <InfoPanel
              branch={nodeBranch}
              substrateSMILES={startSmiles}
              selectedNode={selectedNodeId}
              selectedNodeData={selectedNodeData}
            />
          ) : (
            <Chatbot branch={selectedBranch} substrateSMILES={startSmiles} />
          )}
        </div>

      </div>
    </div>
  )
}
