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
import { FlaskConical, RotateCcw } from 'lucide-react'

// ── Custom node ───────────────────────────────────────────────────────────────

function MoleculeNode({ data }) {
  const cls = [
    'mol-node',
    data.nodeType === 'start'    ? 'start-node'     : '',
    data.matchesTarget           ? 'matches-target'  : '',
    data.isCoupling              ? 'coupling-node'   : '',
    data.branchSelected          ? 'selected'        : '',
    data.nodeSelected            ? 'node-selected'   : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls}>
      {/* Accept connections from above — start nodes may have multiple source handles */}
      {data.nodeType !== 'start' && (
      <Handle type="target" position={Position.Top} className="mol-handle" />
    )}
      <StructureView smiles={data.smiles} width={168} height={118} className="structure-outline" />
      <div className="mol-node-label">
        {data.label}
        {data.isCoupling && (
          <span style={{ marginLeft: 4, fontSize: 9, color: '#bc8cff', verticalAlign: 'middle' }}>⊕</span>
        )}
      </div>
      {data.nodeType !== 'product' && (
        <Handle type="source" position={Position.Bottom} className="mol-handle" />
      )}
    </div>
  )
}

const NODE_TYPES = { molecule: MoleculeNode }

// ── Fanout layout (existing, unchanged) ───────────────────────────────────────

function buildFanoutGraph(data, selectedBranchIds, selectedBranchId, selectedNodeId) {
  if (!data?.branches?.length) return { nodes: [], edges: [] }

  const nodes = []
  const edges = []
  const BRANCH_W = 270
  const STEP_H = 225
  const visibleBranches = selectedBranchIds?.length
    ? data.branches.filter(branch => selectedBranchIds.includes(branch.id))
    : data.branches
  const n = visibleBranches.length
  const totalW = Math.max(0, (n - 1) * BRANCH_W)

  const uniqueStarts = [...new Set(visibleBranches.map(b => b.start_smiles_used ?? data.start_smiles?.[0] ?? ''))]
  const multiStart = uniqueStarts.length > 1

  if (!multiStart) {
    nodes.push({
      id: 'start',
      type: 'molecule',
      position: { x: -88, y: 0 },
      data: {
        smiles: data.start_smiles?.[0] ?? '',
        label: 'Starting Material',
        nodeType: 'start',
        nodeSelected: selectedNodeId === 'start',
      },
    })
  } else {
    uniqueStarts.forEach((smi, si) => {
      const x = (si - (uniqueStarts.length - 1) / 2) * BRANCH_W
      nodes.push({
        id: `start_${si}`,
        type: 'molecule',
        position: { x: x - 88, y: 0 },
        data: {
          smiles: smi,
          label: `Starting Material ${si + 1}`,
          nodeType: 'start',
          nodeSelected: selectedNodeId === `start_${si}`,
        },
      })
    })
  }

  visibleBranches.forEach((branch, bi) => {
    const isSelected = selectedBranchIds?.includes(branch.id)
    const isActive = branch.id === selectedBranchId

    const startUsed = branch.start_smiles_used ?? data.start_smiles?.[0] ?? ''
    const startNodeId = multiStart
      ? `start_${uniqueStarts.indexOf(startUsed)}`
      : 'start'
    const bx = (bi * BRANCH_W) - (totalW / 2) - 88

    let prevId = startNodeId

    branch.steps.slice(1).forEach((step, si) => {
      const nodeId = `${branch.id}_s${si + 1}`
      const label  = step.type === 'product'
        ? (branch.matches_target ? 'Target Match' : 'Product')
        : step.label

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
          branchSelected: isSelected || isActive,
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
        labelStyle: { fill: '#111827', fontSize: 11, fontWeight: 700 },
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
        labelBgPadding: [6, 4],
        style: {
          stroke: isSelected || isActive ? '#1d4ed8' : branch.matches_target ? '#15803d' : '#6b7280',
          strokeWidth: isSelected || isActive ? 2.4 : 1.7,
        },
        animated: isSelected || isActive,
      })

      prevId = nodeId
    })
  })

  return { nodes, edges }
}

// ── DAG layout (target-search / convergent) ───────────────────────────────────
//
// Lays out dag_nodes in layers determined by BFS depth from start nodes.
// Multiple start nodes fan across the top. Coupling nodes are centred between
// their two parents. All other nodes stack in their parent's column.

function buildDAGGraph(route, selectedNodeId) {
  if (!route?.dag_nodes?.length) return { nodes: [], edges: [] }

  const { dag_nodes, dag_edges } = route

  // Build adjacency: node id → list of child ids
  const childrenOf = {}
  const parentsOf  = {}
  dag_nodes.forEach(n => { childrenOf[n.id] = []; parentsOf[n.id] = [] })
  dag_edges.forEach(e => {
    childrenOf[e.source]?.push(e.target)
    parentsOf[e.target]?.push(e.source)
  })

  // Assign depth layer by BFS from start nodes
  const depth = {}
  const queue = []
  dag_nodes.forEach(n => {
    if (n.type === 'start') { depth[n.id] = 0; queue.push(n.id) }
  })
  while (queue.length) {
    const cur = queue.shift()
    for (const child of childrenOf[cur]) {
      const d = (depth[cur] ?? 0) + 1
      if (depth[child] === undefined || depth[child] < d) {
        depth[child] = d
        queue.push(child)
      }
    }
  }

  const STEP_H   = 230
  const COL_W    = 250
  const NODE_W   = 190

  // Group nodes by layer
  const layers = {}
  dag_nodes.forEach(n => {
    const d = depth[n.id] ?? 0
    if (!layers[d]) layers[d] = []
    layers[d].push(n.id)
  })

  // Assign x positions: start nodes spread equally; child nodes inherit or centre between parents
  const posX = {}

  const startNodes = dag_nodes.filter(n => n.type === 'start')
  const total = startNodes.length
  startNodes.forEach((n, i) => {
    posX[n.id] = (i - (total - 1) / 2) * COL_W
  })

  // Process layers in order so parents are positioned before children
  const sortedLayers = Object.keys(layers).map(Number).sort((a, b) => a - b)
  for (const d of sortedLayers) {
    if (d === 0) continue
    for (const nid of layers[d]) {
      const parentIds = parentsOf[nid] ?? []
      if (parentIds.length === 0) continue
      const parentXs = parentIds.map(pid => posX[pid] ?? 0)
      posX[nid] = parentXs.reduce((s, x) => s + x, 0) / parentXs.length
    }
    // Spread nodes in the same layer that have the same x to avoid overlap
    const group = layers[d].map(nid => ({ nid, x: posX[nid] ?? 0 }))
    group.sort((a, b) => a.x - b.x)
    for (let i = 1; i < group.length; i++) {
      if (group[i].x - group[i - 1].x < NODE_W) {
        group[i].x = group[i - 1].x + NODE_W
        posX[group[i].nid] = group[i].x
      }
    }
  }

  const rfNodes = dag_nodes.map(n => ({
    id: n.id,
    type: 'molecule',
    position: { x: (posX[n.id] ?? 0) - 70, y: (depth[n.id] ?? 0) * STEP_H },
    data: {
      smiles: n.smiles,
      label: n.label,
      nodeType: n.type,
      matchesTarget: n.type === 'product',
      isCoupling: n.is_coupling,
      stepText: n.step_text,
      reagentName: n.reagent_name,
      reagentSmiles: n.reagent_smiles,
      environment: n.environment,
      reactionName: n.reaction_name,
      nodeSelected: selectedNodeId === n.id,
      // Expose id so click handler can find it
      dagNodeId: n.id,
    },
  }))

  const rfEdges = dag_edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.reagent_name || e.reaction_name || '',
    labelStyle: { fill: '#111827', fontSize: 11, fontWeight: 700 },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
    labelBgPadding: [6, 4],
    style: {
      stroke: e.is_coupling ? '#b45309' : '#15803d',
      strokeWidth: 2,
    },
    animated: true,
  }))

  return { nodes: rfNodes, edges: rfEdges }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PathwayGraph({
  data,
  selectedRouteId,
  selectedBranchId,
  selectedBranchIds = [],
  selectedNodeId,
  onSelectRoute,
  onSelectBranch,
  onSelectNode,
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges]                = useEdgesState([])

  const baseLayoutRef = useRef({ nodes: [], edges: [] })

  useEffect(() => {
    if (!data) return

    let graph

    if (data.search_mode === 'target_search') {
      const route = data.routes?.find(r => r.id === selectedRouteId) ?? data.routes?.[0]
      graph = route ? buildDAGGraph(route, selectedNodeId) : { nodes: [], edges: [] }
    } else {
      graph = buildFanoutGraph(data, selectedBranchIds, selectedBranchId, selectedNodeId)
    }

    baseLayoutRef.current = graph
    setNodes(graph.nodes)
    setEdges(graph.edges)
  }, [data, selectedRouteId, selectedBranchIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Patch selection state without full rebuild (fanout mode)
  useEffect(() => {
    if (data?.search_mode !== 'fanout') return
    setNodes(prev => prev.map(n => ({
      ...n,
      data: {
        ...n.data,
        branchSelected: selectedBranchIds.includes(n.data.branchId) || n.data.branchId === selectedBranchId,
        nodeSelected: n.id === selectedNodeId,
      },
    })))
    setEdges(prev => prev.map(e => {
      const branchId = e.id.replace(/^e_/, '').replace(/_\d+$/, '')
      const isSel = selectedBranchIds.includes(branchId) || branchId === selectedBranchId
      const matchesTgt = data?.branches?.find(b => b.id === branchId)?.matches_target
      return {
        ...e,
        style: {
          stroke: isSel ? '#1d4ed8' : matchesTgt ? '#15803d' : '#6b7280',
          strokeWidth: isSel ? 2.4 : 1.7,
        },
        animated: isSel,
      }
    }))
  }, [selectedBranchId, selectedBranchIds, selectedNodeId, data?.search_mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Patch node-selected in DAG mode
  useEffect(() => {
    if (data?.search_mode !== 'target_search') return
    setNodes(prev => prev.map(n => ({
      ...n,
      data: { ...n.data, nodeSelected: n.id === selectedNodeId },
    })))
  }, [selectedNodeId, data?.search_mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeClick = useCallback((_, node) => {
    if (data?.search_mode === 'target_search') {
      onSelectNode(node.id, node.data)
    } else {
      if (node.data?.branchId) onSelectBranch(node.data.branchId)
      onSelectNode(node.id, node.data)
    }
  }, [data?.search_mode, onSelectBranch, onSelectNode])

  const handlePaneClick = useCallback(() => {
    onSelectNode(null, null)
  }, [onSelectNode])

  const resetLayout = useCallback(() => {
    setNodes(baseLayoutRef.current.nodes.map(n => ({ ...n })))
  }, [setNodes])

  const isEmpty = data?.search_mode === 'target_search'
    ? !data?.routes?.length
    : !data?.branches?.length

  if (!data || isEmpty) {
    return (
      <div className="empty-graph">
        <div className="big-icon"><FlaskConical size={42} strokeWidth={1.3} /></div>
        <div style={{ fontSize: 14, color: '#111827', fontWeight: 600 }}>Pathway graph will appear here</div>
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
      defaultViewport={{ x: 420, y: 54, zoom: 0.86 }}
      minZoom={0.08}
      maxZoom={2.5}
      colorMode="light"
      style={{ background: '#ffffff' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#e5e7eb" gap={28} size={1} />
      <Controls
        showInteractive={false}
        style={{ background: '#ffffff', border: '1px solid #d1d5db', color: '#111827' }}
      />
      <MiniMap
        nodeColor={n =>
          n.data?.nodeSelected    ? '#d97706' :
          n.data?.matchesTarget   ? '#15803d' :
          n.data?.isCoupling      ? '#b45309' :
          n.data?.nodeType === 'start' ? '#334155' :
          n.data?.branchSelected  ? '#1d4ed8' : '#9ca3af'
        }
        style={{ background: '#ffffff', border: '1px solid #d1d5db' }}
      />
      <Panel position="top-right">
        <button
          onClick={resetLayout}
          title="Reset node positions"
          style={{
            background: '#ffffff', border: '1px solid #d1d5db',
            color: '#374151', borderRadius: 5,
            padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <RotateCcw size={13} />
          Reset layout
        </button>
      </Panel>
    </ReactFlow>
  )
}
