import { useMemo, useRef, useState } from 'react'
import {
  Atom,
  Ban,
  Check,
  Eraser,
  Minus,
  MousePointer2,
  PencilRuler,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import StructureView from './StructureView'

const CANVAS_WIDTH = 720
const CANVAS_HEIGHT = 420
const DEFAULT_BOND = 74

const ATOMS = ['C', 'N', 'O', 'S', 'F', 'Cl', 'Br', 'I']
const BONDS = [
  { order: 1, label: 'Single' },
  { order: 2, label: 'Double' },
  { order: 3, label: 'Triple' },
]

const TEMPLATES = [
  { label: 'Chain', atoms: ['C', 'C', 'C', 'C'], bonds: [[0, 1, 1], [1, 2, 1], [2, 3, 1]] },
  { label: 'Ketone', atoms: ['C', 'C', 'O', 'C'], bonds: [[0, 1, 1], [1, 2, 2], [1, 3, 1]] },
  { label: 'Alcohol', atoms: ['C', 'C', 'O'], bonds: [[0, 1, 1], [1, 2, 1]] },
  { label: 'Alkene', atoms: ['C', 'C', 'C'], bonds: [[0, 1, 2], [1, 2, 1]] },
  { label: 'Benzene', atoms: ['C', 'C', 'C', 'C', 'C', 'C'], bonds: [[0, 1, 2], [1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 0, 1]], ring: true },
]

function makeAtom(element, x, y) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    element,
    x,
    y,
  }
}

function edgeKey(a, b) {
  return [a, b].sort().join('__')
}

function bondSymbol(order) {
  if (order === 2) return '='
  if (order === 3) return '#'
  return ''
}

function atomToken(element) {
  return element === 'H' ? '[H]' : element
}

function nearestOpenPoint(atom, atoms) {
  const angles = [0, -60, 60, 180, -120, 120]
  let best = { x: atom.x + DEFAULT_BOND, y: atom.y }
  let bestScore = -Infinity

  for (const angle of angles) {
    const radians = (angle * Math.PI) / 180
    const point = {
      x: atom.x + Math.cos(radians) * DEFAULT_BOND,
      y: atom.y + Math.sin(radians) * DEFAULT_BOND,
    }
    const score = atoms.reduce((min, other) => {
      const distance = Math.hypot(point.x - other.x, point.y - other.y)
      return Math.min(min, distance)
    }, Infinity)
    if (score > bestScore) {
      bestScore = score
      best = point
    }
  }

  return {
    x: Math.max(44, Math.min(CANVAS_WIDTH - 44, best.x)),
    y: Math.max(44, Math.min(CANVAS_HEIGHT - 44, best.y)),
  }
}

function templateToGraph(template) {
  const cx = CANVAS_WIDTH / 2
  const cy = CANVAS_HEIGHT / 2
  let atoms

  if (template.ring) {
    atoms = template.atoms.map((element, index) => {
      const radians = (-90 + index * 60) * Math.PI / 180
      return makeAtom(element, cx + Math.cos(radians) * 92, cy + Math.sin(radians) * 92)
    })
  } else {
    atoms = template.atoms.map((element, index) => makeAtom(element, cx - 110 + index * 72, cy))
    if (template.label === 'Ketone') {
      atoms[2].x = atoms[1].x
      atoms[2].y = atoms[1].y - 78
      atoms[3].x = atoms[1].x + 74
    }
  }

  const bonds = template.bonds.map(([from, to, order]) => ({
    id: edgeKey(atoms[from].id, atoms[to].id),
    from: atoms[from].id,
    to: atoms[to].id,
    order,
  }))

  return { atoms, bonds }
}

function graphToSmiles(atoms, bonds) {
  if (!atoms.length) return ''

  const atomMap = new Map(atoms.map(atom => [atom.id, atom]))
  const adjacency = new Map(atoms.map(atom => [atom.id, []]))

  for (const bond of bonds) {
    adjacency.get(bond.from)?.push({ id: bond.to, order: bond.order, edge: bond.id })
    adjacency.get(bond.to)?.push({ id: bond.from, order: bond.order, edge: bond.id })
  }

  const globalSeen = new Set()
  const pieces = []

  for (const root of atoms) {
    if (globalSeen.has(root.id)) continue

    const component = []
    const queue = [root.id]
    globalSeen.add(root.id)

    while (queue.length) {
      const current = queue.shift()
      component.push(current)
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!globalSeen.has(neighbor.id)) {
          globalSeen.add(neighbor.id)
          queue.push(neighbor.id)
        }
      }
    }

    const treeEdges = new Set()
    const treeVisited = new Set()

    function buildTree(id, parent = null) {
      treeVisited.add(id)
      const neighbors = [...(adjacency.get(id) ?? [])].sort((a, b) => a.id.localeCompare(b.id))
      for (const neighbor of neighbors) {
        if (neighbor.id === parent) continue
        if (!treeVisited.has(neighbor.id)) {
          treeEdges.add(edgeKey(id, neighbor.id))
          buildTree(neighbor.id, id)
        }
      }
    }

    buildTree(root.id)

    const ringDigits = new Map()
    let nextDigit = 1
    for (const bond of bonds) {
      if (!component.includes(bond.from) || !component.includes(bond.to)) continue
      if (!treeEdges.has(edgeKey(bond.from, bond.to))) {
        ringDigits.set(edgeKey(bond.from, bond.to), nextDigit)
        nextDigit = nextDigit === 9 ? 1 : nextDigit + 1
      }
    }

    const renderVisited = new Set()

    function render(id, parent = null) {
      renderVisited.add(id)
      const atom = atomMap.get(id)
      let text = atomToken(atom.element)

      const ringNeighbors = (adjacency.get(id) ?? [])
        .filter(neighbor => ringDigits.has(edgeKey(id, neighbor.id)))
        .sort((a, b) => a.id.localeCompare(b.id))

      for (const neighbor of ringNeighbors) {
        text += `${bondSymbol(neighbor.order)}${ringDigits.get(edgeKey(id, neighbor.id))}`
      }

      const treeNeighbors = (adjacency.get(id) ?? [])
        .filter(neighbor => neighbor.id !== parent && treeEdges.has(edgeKey(id, neighbor.id)) && !renderVisited.has(neighbor.id))
        .sort((a, b) => a.id.localeCompare(b.id))

      treeNeighbors.forEach((neighbor, index) => {
        const segment = `${bondSymbol(neighbor.order)}${render(neighbor.id, id)}`
        text += index === 0 ? segment : `(${segment})`
      })

      return text
    }

    pieces.push(render(root.id))
  }

  return pieces.join('.')
}

function lineForBond(from, to, order) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const offsetX = (-dy / length) * 5
  const offsetY = (dx / length) * 5

  if (order === 1) return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y }]
  if (order === 2) {
    return [
      { x1: from.x + offsetX, y1: from.y + offsetY, x2: to.x + offsetX, y2: to.y + offsetY },
      { x1: from.x - offsetX, y1: from.y - offsetY, x2: to.x - offsetX, y2: to.y - offsetY },
    ]
  }
  return [
    { x1: from.x, y1: from.y, x2: to.x, y2: to.y },
    { x1: from.x + offsetX * 1.55, y1: from.y + offsetY * 1.55, x2: to.x + offsetX * 1.55, y2: to.y + offsetY * 1.55 },
    { x1: from.x - offsetX * 1.55, y1: from.y - offsetY * 1.55, x2: to.x - offsetX * 1.55, y2: to.y - offsetY * 1.55 },
  ]
}

function getSvgPoint(event, svg) {
  const rect = svg.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
  }
}

function MolDrawerDialog({ initialValue, onApply, onClose }) {
  const [atoms, setAtoms] = useState([])
  const [bonds, setBonds] = useState([])
  const [atomTool, setAtomTool] = useState('C')
  const [bondOrder, setBondOrder] = useState(1)
  const [mode, setMode] = useState('bond')
  const [selectedAtom, setSelectedAtom] = useState(null)
  const [history, setHistory] = useState([])
  const [dragging, setDragging] = useState(null)
  const svgRef = useRef(null)

  const smiles = useMemo(() => graphToSmiles(atoms, bonds), [atoms, bonds])
  const selectedAtomData = atoms.find(atom => atom.id === selectedAtom)

  function commit(nextAtoms, nextBonds) {
    setHistory(prev => [...prev.slice(-24), { atoms, bonds }])
    setAtoms(nextAtoms)
    setBonds(nextBonds)
  }

  function addAtomAt(point, element = atomTool, connectFrom = selectedAtom) {
    const atom = makeAtom(element, point.x, point.y)
    const nextAtoms = [...atoms, atom]
    const nextBonds = connectFrom
      ? [...bonds, { id: edgeKey(connectFrom, atom.id), from: connectFrom, to: atom.id, order: bondOrder }]
      : bonds
    commit(nextAtoms, nextBonds)
    setSelectedAtom(atom.id)
  }

  function updateAtom(id, element) {
    commit(atoms.map(atom => atom.id === id ? { ...atom, element } : atom), bonds)
    setSelectedAtom(id)
  }

  function deleteAtom(id) {
    commit(
      atoms.filter(atom => atom.id !== id),
      bonds.filter(bond => bond.from !== id && bond.to !== id),
    )
    setSelectedAtom(null)
  }

  function connectAtoms(from, to) {
    if (from === to) return
    const key = edgeKey(from, to)
    const existing = bonds.find(bond => bond.id === key)
    const nextBonds = existing
      ? bonds.map(bond => bond.id === key ? { ...bond, order: bondOrder } : bond)
      : [...bonds, { id: key, from, to, order: bondOrder }]
    commit(atoms, nextBonds)
    setSelectedAtom(to)
  }

  function deleteBond(id) {
    commit(atoms, bonds.filter(bond => bond.id !== id))
  }

  function handleAtomClick(event, atom) {
    event.stopPropagation()
    if (dragging?.moved) return
    if (mode === 'erase') {
      deleteAtom(atom.id)
      return
    }
    if (mode === 'atom') {
      updateAtom(atom.id, atomTool)
      return
    }
    if (selectedAtom && selectedAtom !== atom.id) {
      connectAtoms(selectedAtom, atom.id)
      return
    }
    setSelectedAtom(atom.id)
  }

  function handleCanvasClick(event) {
    if (!svgRef.current || dragging) return
    const point = getSvgPoint(event, svgRef.current)
    if (mode === 'atom') {
      addAtomAt(point, atomTool, null)
      return
    }
    if (mode === 'bond') {
      if (selectedAtom) addAtomAt(point, 'C', selectedAtom)
      else addAtomAt(point, atomTool, null)
    }
  }

  function startDrag(event, atom) {
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedAtom(atom.id)
    setDragging({ id: atom.id, moved: false })
  }

  function moveDrag(event) {
    if (!dragging || !svgRef.current) return
    const point = getSvgPoint(event, svgRef.current)
    setDragging(current => current ? { ...current, moved: true } : null)
    setAtoms(current => current.map(atom => atom.id === dragging.id ? {
      ...atom,
      x: Math.max(28, Math.min(CANVAS_WIDTH - 28, point.x)),
      y: Math.max(28, Math.min(CANVAS_HEIGHT - 28, point.y)),
    } : atom))
  }

  function finishDrag() {
    if (dragging?.moved) {
      setHistory(prev => [...prev.slice(-24), { atoms, bonds }])
    }
    setTimeout(() => setDragging(null), 0)
  }

  function extendSelected() {
    if (!selectedAtomData) {
      addAtomAt({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }, atomTool, null)
      return
    }
    addAtomAt(nearestOpenPoint(selectedAtomData, atoms), atomTool, selectedAtomData.id)
  }

  function undo() {
    const previous = history.at(-1)
    if (!previous) return
    setAtoms(previous.atoms)
    setBonds(previous.bonds)
    setHistory(prev => prev.slice(0, -1))
  }

  function clear() {
    commit([], [])
    setSelectedAtom(null)
  }

  function applyTemplate(template) {
    const graph = templateToGraph(template)
    commit(graph.atoms, graph.bonds)
    setSelectedAtom(graph.atoms[0]?.id ?? null)
  }

  return (
    <div className="mol-drawer-backdrop" role="dialog" aria-modal="true" aria-label="Molecule drawer">
      <div className="mol-drawer-modal">
        <div className="mol-drawer-header">
          <div>
            <div className="eyebrow">MolDrawer</div>
            <h3>Draw molecule</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close molecule drawer">
            <X size={16} />
          </button>
        </div>

        <div className="mol-drawer-body">
          <aside className="mol-drawer-tools">
            <div className="mol-tool-group">
              <span>Mode</span>
              <div className="mol-tool-row">
                <button type="button" className={`mol-tool${mode === 'bond' ? ' active' : ''}`} onClick={() => setMode('bond')} title="Draw bonds">
                  <Minus size={15} />
                  Bond
                </button>
                <button type="button" className={`mol-tool${mode === 'atom' ? ' active' : ''}`} onClick={() => setMode('atom')} title="Place atoms">
                  <Atom size={15} />
                  Atom
                </button>
                <button type="button" className={`mol-tool${mode === 'erase' ? ' active' : ''}`} onClick={() => setMode('erase')} title="Erase atoms or bonds">
                  <Eraser size={15} />
                  Erase
                </button>
              </div>
            </div>

            <div className="mol-tool-group">
              <span>Atom</span>
              <div className="mol-atom-grid">
                {ATOMS.map(element => (
                  <button
                    key={element}
                    type="button"
                    className={`mol-atom-button${atomTool === element ? ' active' : ''}`}
                    onClick={() => {
                      setAtomTool(element)
                      setMode('atom')
                    }}
                  >
                    {element}
                  </button>
                ))}
              </div>
            </div>

            <div className="mol-tool-group">
              <span>Bond</span>
              <div className="mol-tool-row">
                {BONDS.map(item => (
                  <button
                    key={item.order}
                    type="button"
                    className={`mol-tool compact${bondOrder === item.order ? ' active' : ''}`}
                    onClick={() => {
                      setBondOrder(item.order)
                      setMode('bond')
                    }}
                    title={item.label}
                  >
                    {item.order === 1 ? '-' : item.order === 2 ? '=' : '#'}
                  </button>
                ))}
              </div>
            </div>

            <div className="mol-tool-group">
              <span>Templates</span>
              <div className="mol-template-list">
                {TEMPLATES.map(template => (
                  <button key={template.label} type="button" className="mol-template-button" onClick={() => applyTemplate(template)}>
                    {template.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mol-tool-group">
              <span>Edit</span>
              <div className="mol-tool-row">
                <button type="button" className="mol-tool" onClick={extendSelected} title="Extend selected atom">
                  <PencilRuler size={15} />
                  Add
                </button>
                <button type="button" className="mol-tool" onClick={undo} disabled={!history.length} title="Undo">
                  <RotateCcw size={15} />
                </button>
                <button type="button" className="mol-tool danger" onClick={clear} disabled={!atoms.length} title="Clear drawing">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          </aside>

          <main className="mol-drawer-stage">
            <div className="mol-canvas-shell">
              <svg
                ref={svgRef}
                className="mol-canvas"
                viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                onClick={handleCanvasClick}
                onPointerMove={moveDrag}
                onPointerUp={finishDrag}
                onPointerLeave={finishDrag}
              >
                <defs>
                  <pattern id="mol-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                    <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(101,113,125,0.12)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} rx="18" fill="url(#mol-grid)" />

                {bonds.map(bond => {
                  const from = atoms.find(atom => atom.id === bond.from)
                  const to = atoms.find(atom => atom.id === bond.to)
                  if (!from || !to) return null
                  return (
                    <g key={bond.id} onClick={event => {
                      event.stopPropagation()
                      if (mode === 'erase') deleteBond(bond.id)
                    }}>
                      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="mol-bond-hit" />
                      {lineForBond(from, to, bond.order).map((line, index) => (
                        <line key={index} {...line} className="mol-bond-line" />
                      ))}
                    </g>
                  )
                })}

                {atoms.map(atom => (
                  <g
                    key={atom.id}
                    className={`mol-atom${selectedAtom === atom.id ? ' selected' : ''}`}
                    transform={`translate(${atom.x} ${atom.y})`}
                    onPointerDown={event => startDrag(event, atom)}
                    onClick={event => handleAtomClick(event, atom)}
                  >
                    <circle r="18" />
                    <text textAnchor="middle" dominantBaseline="central">{atom.element}</text>
                  </g>
                ))}

                {!atoms.length && (
                  <g className="mol-canvas-empty">
                    <MousePointer2 size={36} x={CANVAS_WIDTH / 2 - 18} y={CANVAS_HEIGHT / 2 - 52} />
                    <text x={CANVAS_WIDTH / 2} y={CANVAS_HEIGHT / 2 + 8} textAnchor="middle">
                      Click to place an atom, or choose a template.
                    </text>
                  </g>
                )}
              </svg>
            </div>

            <div className="mol-drawer-output">
              <div className="mol-output-main">
                <span className="smiles-label">Generated SMILES</span>
                <code>{smiles || initialValue || 'Draw a structure to generate SMILES.'}</code>
              </div>
              <div className="mol-output-preview">
                {smiles ? (
                  <StructureView smiles={smiles} width={210} height={120} className="structure-outline" />
                ) : (
                  <span><Ban size={16} /> No structure yet</span>
                )}
              </div>
              <button type="button" className="btn-primary action-button" disabled={!smiles} onClick={() => onApply(smiles)}>
                <Check size={15} />
                Use molecule
              </button>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

export default function MolDrawer({ value = '', onChange, buttonLabel = 'Draw', className = '' }) {
  const [open, setOpen] = useState(false)

  function apply(smiles) {
    onChange(smiles)
    setOpen(false)
  }

  return (
    <>
      <button type="button" className={`btn-icon mol-drawer-trigger ${className}`} onClick={() => setOpen(true)}>
        <PencilRuler size={14} />
        {buttonLabel}
      </button>
      {open && (
        <MolDrawerDialog
          initialValue={value}
          onApply={apply}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
