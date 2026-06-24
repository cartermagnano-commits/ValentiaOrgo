import { useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import StructureView from './StructureView'

// ── Custom node ───────────────────────────────────────────────────────────────

function MoleculeNode({ data }) {
  const cls = [
    'mol-node',
    data.nodeType === 'start'      ? 'start-node'    : '',
    data.matchesTarget             ? 'matches-target' : '',  // set from branch.matches_target below
    data.branchSelected            ? 'selected'       : '',
    data.nodeSelected              ? 'node-selected'  : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls}>
      {data.nodeType !== 'start' && (
        <Handle type="target" position={Position.Top} style={{ background: '#374151' }} />
      )}
      <StructureView smiles={data.smiles} width={132} height={96} />
      <div className="mol-node-label">{data.label}</div>
      {data.nodeType !== 'product' && (
        <Handle type="source" position={Position.Bottom} style={{ background: '#374151' }} />
      )}
    </div>
  )
}

const NODE_TYPES = { molecule: MoleculeNode }

// ── Layout builder ────────────────────────────────────────────────────────────

function buildGraph(data, selectedBranchId, selectedNodeId) {
  if (!data?.branches?.length) return { nodes: [], edges: [] }

  const nodes = []
  const edges = []
  const BRANCH_W = 190
  const STEP_H   = 185
  const n         = data.branches.length
  const totalW    = (n - 1) * BRANCH_W
  const startX    = totalW / 2

  // Shared start node
  nodes.push({
    id: 'start',
    type: 'molecule',
    position: { x: startX - 70, y: 0 },
    data: {
      smiles: data.start_smiles,
      label: 'Starting Material',
      nodeType: 'start',
      nodeSelected: selectedNodeId === 'start',
    },
  })

  data.branches.forEach((branch, bi) => {
    const bx   = bi * BRANCH_W - 70
    const isSel = branch.id === selectedBranchId
    let prevId  = 'start'

    branch.steps.slice(1).forEach((step, si) => {
      const nodeId = `${branch.id}_s${si + 1}`
      const label  = step.type === 'product'
        ? (branch.matches_target ? '✓ Target Match' : 'Product')
        : step.label

      // Per-step reagent takes priority; fall back to branch-level for single-reagent branches
      const stepReagentName = step.reagent_name ?? (si === 0 ? branch.reagent?.name : null)

      nodes.push({
        id: nodeId,
        type: 'molecule',
        position: { x: bx, y: (si + 1) * STEP_H },
        data: {
          smiles: step.smiles,
          label,
          nodeType: step.type,
          stepIndex: step.step_index,
          stepText: step.step_text,
          matchesTarget: step.type === 'product' && branch.matches_target,
          branchSelected: isSel,
          nodeSelected: selectedNodeId === nodeId,
          branchId: branch.id,
          reagentName: stepReagentName,
          reagentSmiles: step.reagent_smiles ?? branch.reagent?.smiles,
          environment: step.environment ?? branch.environment,
          reactionClassification: branch.reaction_classification,
          executionHistory: branch.execution_history,
        },
      })

      edges.push({
        id: `e_${branch.id}_${si}`,
        source: prevId,
        target: nodeId,
        label: stepReagentName ?? '',
        labelStyle: { fill: '#8b949e', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#0d1117', fillOpacity: 0.85 },
        style: {
          stroke: isSel
            ? '#58a6ff'
            : branch.matches_target
            ? '#3fb950'
            : '#374151',
          strokeWidth: isSel ? 2 : 1.5,
        },
        animated: isSel,
      })

      prevId = nodeId
    })
  })

  return { nodes, edges }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PathwayGraph({
  data,
  selectedBranchId,
  selectedNodeId,
  onSelectBranch,
  onSelectNode,
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges]                = useEdgesState([])

  // Track latest layout for reset
  const baseLayoutRef = useRef({ nodes: [], edges: [] })

  // Rebuild everything when data changes (new query)
  useEffect(() => {
    const graph = buildGraph(data, selectedBranchId, selectedNodeId)
    baseLayoutRef.current = graph
    setNodes(graph.nodes)
    setEdges(graph.edges)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  // When selection changes, patch node data without resetting positions
  useEffect(() => {
    setNodes(prev => prev.map(n => ({
      ...n,
      data: {
        ...n.data,
        branchSelected: n.data.branchId === selectedBranchId,
        nodeSelected: n.id === selectedNodeId,
      },
    })))
    setEdges(prev => prev.map(e => {
      const branchId = e.id.replace(/^e_/, '').replace(/_\d+$/, '')
      const isSel = branchId === selectedBranchId
      const matchesTgt = data?.branches?.find(b => b.id === branchId)?.matches_target
      return {
        ...e,
        style: {
          stroke: isSel ? '#58a6ff' : matchesTgt ? '#3fb950' : '#374151',
          strokeWidth: isSel ? 2 : 1.5,
        },
        animated: isSel,
      }
    }))
  }, [selectedBranchId, selectedNodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeClick = useCallback((_, node) => {
    if (node.data?.branchId) onSelectBranch(node.data.branchId)
    onSelectNode(node.id, node.data)
  }, [onSelectBranch, onSelectNode])

  const handlePaneClick = useCallback(() => {
    onSelectNode(null, null)
  }, [onSelectNode])

  const resetLayout = useCallback(() => {
    setNodes(baseLayoutRef.current.nodes.map(n => ({ ...n })))
  }, [setNodes])

  if (!data?.branches?.length) {
    return (
      <div className="empty-graph">
        <div className="big-icon">⚗</div>
        <div style={{ fontSize: 14, color: 'var(--text)' }}>Pathway graph will appear here</div>
        <div style={{ fontSize: 12 }}>Enter a starting material and click Analyze Pathways</div>
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      nodesDraggable
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.15}
      maxZoom={2.5}
      colorMode="dark"
      style={{ background: 'var(--bg)' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#30363d" gap={24} size={1} />
      <Controls
        showInteractive={false}
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      />
      <MiniMap
        nodeColor={n =>
          n.data?.nodeSelected    ? '#f0a500' :
          n.data?.matchesTarget   ? '#3fb950' :  // set from branch.matches_target
          n.data?.nodeType === 'start' ? '#bc8cff' :
          n.data?.branchSelected  ? '#58a6ff' : '#374151'
        }
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      />
      <Panel position="top-right">
        <button
          onClick={resetLayout}
          title="Reset node positions"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            borderRadius: 5,
            padding: '4px 10px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          ↺ Reset layout
        </button>
      </Panel>
    </ReactFlow>
  )
}
