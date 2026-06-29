import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Beaker,
  Bot,
  CalendarDays,
  Clock3,
  FileText,
  FlaskConical,
  FolderKanban,
  GitBranch,
  MessageSquare,
  Microscope,
  Network,
  NotebookText,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import PathwayExplorer from './components/PathwayExplorer'
import DirectReact from './components/DirectReact'
import ReactPredict from './components/ReactPredict'

/** @typedef {import('./types').Project} Project */
/** @typedef {import('./types').ChemistryFile} ChemistryFile */
/** @typedef {import('./types').ChemistryFileType} ChemistryFileType */

const FILE_TYPES = [
  { type: 'synthesis', code: 'SYN', label: 'Synthesis', icon: Network, description: 'Pathway exploration and saved synthesis routes' },
  { type: 'direct-reaction', code: 'RXN', label: 'Direct reaction', icon: FlaskConical, description: 'Reactants, reagents, conditions, predicted products' },
  { type: 'predict-reaction', code: 'PRED', label: 'Predict reaction', icon: Sparkles, description: 'Photo or structured reaction prediction' },
  { type: 'mechanism', code: 'MECH', label: 'Mechanism', icon: GitBranch, description: 'Mechanism steps and electron-pushing notes' },
  { type: 'retrosynthesis', code: 'RETRO', label: 'Retrosynthesis', icon: Search, description: 'Target disconnections and precursor planning' },
  { type: 'molecule-note', code: 'MOL', label: 'Molecule note', icon: Microscope, description: 'SMILES, functional groups, observations' },
  { type: 'chat', code: 'NOTE', label: 'General chat', icon: MessageSquare, description: 'Project-scoped chemistry notes and assistant chat' },
]

const nowIso = () => new Date().toISOString()
const newId = prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

function statusText(value) {
  const diffMs = Date.now() - new Date(value).getTime()
  const days = Math.max(0, Math.floor(diffMs / 86400000))
  if (days === 0) return 'Edited recently'
  if (days === 1) return 'Edited yesterday'
  return `Edited ${days} days ago`
}

function fileTypeMeta(type) {
  return FILE_TYPES.find(item => item.type === type) ?? FILE_TYPES[0]
}

function makeFile(projectId, type, title) {
  const createdAt = nowIso()
  return {
    id: newId('file'),
    projectId,
    title,
    type,
    createdAt,
    updatedAt: createdAt,
    content: makeInitialContent(type),
  }
}

function makeInitialContent(type) {
  if (type === 'synthesis') {
    return { targetMolecule: '', startingMaterials: [''], constraints: '', notes: '', aiResponse: '' }
  }
  if (type === 'direct-reaction') {
    return { reactants: [''], reagents: '', solventConditions: '', predictedProducts: [], notes: '', aiResponse: '' }
  }
  if (type === 'predict-reaction') {
    return { reactants: [''], reagents: '', conditions: '', predictedMajorProduct: '', sideProducts: [], notes: '', aiResponse: '' }
  }
  if (type === 'mechanism') {
    return { reactionInput: '', mechanismSteps: [], electronPushingNotes: '', notes: '', aiResponse: '' }
  }
  if (type === 'retrosynthesis') {
    return { targetMolecule: '', disconnections: [], proposedPrecursors: [], notes: '', aiResponse: '' }
  }
  if (type === 'molecule-note') {
    return { moleculeName: '', smiles: '', functionalGroups: [], notes: '', savedObservations: [] }
  }
  return { notes: '', messages: [] }
}

function seedData() {
  const createdAt = '2026-06-20T14:12:00.000Z'
  const updatedAt = '2026-06-28T14:40:00.000Z'
  const p1 = {
    id: 'project_homework',
    name: 'Carbonyl Chemistry Homework',
    description: 'Saved reaction explorations for enolates, substitutions, and mechanism review.',
    fileIds: ['file_pathways', 'file_direct', 'file_mech'],
    createdAt,
    updatedAt,
  }
  const p2 = {
    id: 'project_synthesis',
    name: 'Research Compound Route',
    description: 'Early route sketches and retrosynthetic ideas for a substituted ketone target.',
    fileIds: ['file_retro', 'file_photo'],
    createdAt: '2026-06-24T10:30:00.000Z',
    updatedAt: '2026-06-27T19:05:00.000Z',
  }
  return {
    projects: [p1, p2],
    files: [
      { id: 'file_pathways', projectId: p1.id, title: 'Enolate pathway scan', type: 'synthesis', content: makeInitialContent('synthesis'), createdAt, updatedAt },
      { id: 'file_direct', projectId: p1.id, title: 'Alkyl bromide + base', type: 'direct-reaction', content: makeInitialContent('direct-reaction'), createdAt, updatedAt },
      { id: 'file_mech', projectId: p1.id, title: 'E2 mechanism notes', type: 'mechanism', content: makeInitialContent('mechanism'), createdAt, updatedAt },
      { id: 'file_retro', projectId: p2.id, title: 'Ketone target retrosynthesis', type: 'retrosynthesis', content: makeInitialContent('retrosynthesis'), createdAt: p2.createdAt, updatedAt: p2.updatedAt },
      { id: 'file_photo', projectId: p2.id, title: 'Whiteboard reaction prediction', type: 'predict-reaction', content: makeInitialContent('predict-reaction'), createdAt: p2.createdAt, updatedAt: p2.updatedAt },
    ],
  }
}

export default function App() {
  const seed = useMemo(seedData, [])
  const [projects, setProjects] = useState(seed.projects)
  const [files, setFiles] = useState(seed.files)
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [activeFileId, setActiveFileId] = useState(null)
  const [projectModalOpen, setProjectModalOpen] = useState(false)
  const [fileModalOpen, setFileModalOpen] = useState(false)

  const activeProject = projects.find(project => project.id === activeProjectId) ?? null
  const projectFiles = activeProject ? files.filter(file => file.projectId === activeProject.id) : []
  const activeFile = projectFiles.find(file => file.id === activeFileId) ?? null

  function createProject({ name, description }) {
    const timestamp = nowIso()
    const project = {
      id: newId('project'),
      name,
      description,
      fileIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    setProjects(prev => [project, ...prev])
    setActiveProjectId(project.id)
    setActiveFileId(null)
  }

  function createFile({ title, type }) {
    if (!activeProject) return
    const file = makeFile(activeProject.id, type, title)
    setFiles(prev => [file, ...prev])
    setProjects(prev => prev.map(project =>
      project.id === activeProject.id
        ? { ...project, fileIds: [file.id, ...project.fileIds], updatedAt: file.updatedAt }
        : project
    ))
    setActiveFileId(file.id)
  }

  if (!activeProject) {
    return (
      <div className="platform-app">
        <AppTopbar />
        <Dashboard
          projects={projects}
          files={files}
          onOpenProject={projectId => {
            setActiveProjectId(projectId)
            const firstFile = files.find(file => file.projectId === projectId)
            setActiveFileId(firstFile?.id ?? null)
          }}
          onNewProject={() => setProjectModalOpen(true)}
        />
        {projectModalOpen && (
          <NewProjectModal
            onClose={() => setProjectModalOpen(false)}
            onCreate={payload => {
              createProject(payload)
              setProjectModalOpen(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="platform-app">
      <ProjectWorkspace
        project={activeProject}
        files={projectFiles}
        activeFile={activeFile}
        onBack={() => {
          setActiveProjectId(null)
          setActiveFileId(null)
        }}
        onSelectFile={setActiveFileId}
        onNewFile={() => setFileModalOpen(true)}
      />
      {fileModalOpen && (
        <NewFileModal
          onClose={() => setFileModalOpen(false)}
          onCreate={payload => {
            createFile(payload)
            setFileModalOpen(false)
          }}
        />
      )}
    </div>
  )
}

function AppTopbar() {
  return (
    <header className="platform-topbar">
      <div className="brand-mark">
        <Beaker size={18} />
      </div>
      <div>
        <h1>Orgo AI</h1>
        <div className="subtitle">Project-based organic chemistry workspace</div>
      </div>
    </header>
  )
}

function Dashboard({ projects, files, onOpenProject, onNewProject }) {
  return (
    <main className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <div className="eyebrow">Projects</div>
          <h2>Chemistry workspaces</h2>
          <p>Organize synthesis plans, homework sets, reaction predictions, and research notes by project.</p>
        </div>
        <button className="btn-primary action-button" onClick={onNewProject}>
          <Plus size={16} />
          New Project
        </button>
      </div>

      <div className="project-grid">
        {!projects.length && (
          <div className="dashboard-empty-state">
            <FolderKanban size={34} />
            <h3>No projects yet</h3>
            <p>Create a workspace for a homework set, synthesis plan, or research compound.</p>
            <button className="btn-primary action-button" onClick={onNewProject}>
              <Plus size={16} />
              New Project
            </button>
          </div>
        )}
        {projects.map(project => {
          const count = files.filter(file => file.projectId === project.id).length
          return (
            <button key={project.id} className="project-card" onClick={() => onOpenProject(project.id)}>
              <div className="project-card-icon">
                <FolderKanban size={20} />
              </div>
              <div className="project-card-main">
                <div className="project-status-row">
                  <span className="status-pill saved">Saved</span>
                  <span className="status-pill muted">{statusText(project.updatedAt)}</span>
                </div>
                <h3>{project.name}</h3>
                <p>{project.description || 'No description yet.'}</p>
              </div>
              <div className="project-card-meta">
                <span><FileText size={13} /> {count} file{count === 1 ? '' : 's'}</span>
                <span><CalendarDays size={13} /> Created {formatDate(project.createdAt)}</span>
                <span><Clock3 size={13} /> Updated {formatDate(project.updatedAt)}</span>
              </div>
            </button>
          )
        })}
      </div>
    </main>
  )
}

function ProjectWorkspace({ project, files, activeFile, onBack, onSelectFile, onNewFile }) {
  return (
    <div className="project-workspace">
      <header className="project-header">
        <button className="icon-text-button" onClick={onBack}>
          <ArrowLeft size={15} />
          Projects
        </button>
        <div>
          <h2>{project.name}</h2>
          <p>{project.description || 'No project description.'}</p>
        </div>
      </header>

      <div className="workspace-body">
        <aside className="file-sidebar">
          <div className="file-sidebar-header">
            <div>
              <div className="eyebrow">Files</div>
              <strong>{files.length} saved</strong>
            </div>
            <button className="micro-button" onClick={onNewFile}>
              <Plus size={13} />
              New File
            </button>
          </div>

          <div className="file-list">
            {!files.length && (
              <div className="sidebar-empty-state">
                <NotebookText size={28} />
                <strong>No chemistry files</strong>
                <span>Create the first saved operation for this project.</span>
              </div>
            )}
            {files.map(file => {
              const meta = fileTypeMeta(file.type)
              const Icon = meta.icon
              return (
                <button
                  key={file.id}
                  className={`file-list-item${activeFile?.id === file.id ? ' active' : ''}`}
                  onClick={() => onSelectFile(file.id)}
                >
                  <Icon size={15} />
                  <span>
                    <strong>
                      {file.title}
                      <span className="file-type-badge">{meta.code}</span>
                    </strong>
                    <small>{statusText(file.updatedAt)} · AI not run yet</small>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <main className="file-workspace">
          {activeFile ? (
            <FileWorkspace file={activeFile} files={files} />
          ) : (
            <EmptyFileState onNewFile={onNewFile} />
          )}
        </main>
      </div>
    </div>
  )
}

function EmptyFileState({ onNewFile }) {
  return (
    <div className="workspace-empty-state">
      <NotebookText size={38} />
      <h3>Select or create a file</h3>
      <p>Create a saved chemistry operation inside this project, or choose an existing file from the sidebar.</p>
      <button className="btn-primary action-button" onClick={onNewFile}>
        <Plus size={16} />
        New File
      </button>
    </div>
  )
}

function FileWorkspace({ file, files }) {
  const meta = fileTypeMeta(file.type)
  const Icon = meta.icon
  const related = files.filter(other => other.type === file.type && other.id !== file.id)

  return (
    <section className="file-editor-shell">
      <div className="file-editor-header">
        <div className="file-title-row">
          <span className="file-type-icon"><Icon size={17} /></span>
          <div>
            <div className="file-heading-meta">
              <span className="file-type-badge strong">{meta.code}</span>
              <span className="status-pill saved">Saved</span>
              <span className="status-pill muted">AI not run yet</span>
            </div>
            <h3>{file.title}</h3>
          </div>
        </div>
        <div className="file-dates">
          {statusText(file.updatedAt)} · Created {formatDate(file.createdAt)}
        </div>
      </div>

      {(file.type === 'synthesis' || file.type === 'direct-reaction' || file.type === 'predict-reaction') && (
        <RelatedTabs currentFile={file} related={related} />
      )}

      <div className="file-editor-content">
        {file.type === 'synthesis' && <PathwayExplorer />}
        {file.type === 'direct-reaction' && <DirectReact />}
        {file.type === 'predict-reaction' && <ReactPredict />}
        {file.type === 'mechanism' && <MechanismEditor />}
        {file.type === 'retrosynthesis' && <RetrosynthesisEditor />}
        {file.type === 'molecule-note' && <MoleculeNoteEditor />}
        {file.type === 'chat' && <ChatFileEditor />}
      </div>
    </section>
  )
}

function RelatedTabs({ currentFile, related }) {
  return (
    <div className="related-file-tabs">
      <span className="related-tab active">{currentFile.title}</span>
      {related.map(file => (
        <span key={file.id} className="related-tab">{file.title}</span>
      ))}
      {!related.length && <span className="related-empty">No previous saved files of this type in this project.</span>}
    </div>
  )
}

function MechanismEditor() {
  return (
    <GenericEditor
      sections={[
        ['Reaction input', 'Paste reaction SMILES, reagent context, or a plain-language reaction description.'],
        ['Mechanism steps', 'Step 1: describe bond formation/breaking. Add more steps as this file evolves.'],
        ['Electron-pushing notes', 'Capture curved-arrow logic, nucleophile/electrophile assignments, and charges.'],
        ['Notes', 'General study notes and assumptions.'],
        ['AI response placeholder', 'AI-generated mechanism explanation will appear here.'],
      ]}
    />
  )
}

function RetrosynthesisEditor() {
  return (
    <GenericEditor
      sections={[
        ['Target molecule', 'Target SMILES or molecule name.'],
        ['Disconnections', 'Key bonds to disconnect and rationale.'],
        ['Proposed precursors', 'Candidate starting materials and synthetic equivalents.'],
        ['Notes', 'Constraints, protecting-group concerns, and route assumptions.'],
        ['AI response placeholder', 'AI-generated retrosynthetic plan will appear here.'],
      ]}
    />
  )
}

function MoleculeNoteEditor() {
  return (
    <GenericEditor
      sections={[
        ['Molecule name', 'Common name, project code, or IUPAC shorthand.'],
        ['SMILES string', 'Canonical or working SMILES.'],
        ['Functional groups', 'Alcohol, ketone, alkyl halide, alkene, etc.'],
        ['Notes', 'Reactivity, hazards, synthesis context, or observations.'],
        ['Saved observations', 'Experimental or study observations attached to this molecule.'],
      ]}
    />
  )
}

function ChatFileEditor() {
  return (
    <div className="generic-editor">
      <label>
        <span>Chat notes</span>
        <textarea rows={12} placeholder="Use this file as a project-scoped chat scratchpad for now." />
      </label>
      <div className="ai-placeholder">
        <Bot size={16} />
        Chat responses will appear here when project-file persistence is connected.
      </div>
    </div>
  )
}

function GenericEditor({ sections }) {
  return (
    <div className="generic-editor">
      {sections.map(([label, placeholder]) => (
        <label key={label}>
          <span>{label}</span>
          <textarea rows={label.includes('placeholder') ? 5 : 3} placeholder={placeholder} />
        </label>
      ))}
    </div>
  )
}

function NewProjectModal({ onClose, onCreate }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  function submit(event) {
    event.preventDefault()
    if (!name.trim()) return
    onCreate({ name: name.trim(), description: description.trim() })
  }

  return (
    <Modal title="New Project" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          <span>Project name</span>
          <input value={name} onChange={event => setName(event.target.value)} autoFocus />
        </label>
        <label>
          <span>Description</span>
          <textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>Create project</button>
        </div>
      </form>
    </Modal>
  )
}

function NewFileModal({ onClose, onCreate }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState('synthesis')
  const selectedMeta = fileTypeMeta(type)
  const SelectedIcon = selectedMeta.icon

  function submit(event) {
    event.preventDefault()
    if (!title.trim()) return
    onCreate({ title: title.trim(), type })
  }

  return (
    <Modal title="New File" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          <span>File title</span>
          <input value={title} onChange={event => setTitle(event.target.value)} autoFocus />
        </label>
        <label>
          <span>File type</span>
          <select value={type} onChange={event => setType(event.target.value)}>
            {FILE_TYPES.map(item => (
              <option key={item.type} value={item.type}>{item.label}</option>
            ))}
          </select>
        </label>
        <div className="file-type-help">
          <SelectedIcon size={15} />
          <span className="file-type-badge">{selectedMeta.code}</span>
          {selectedMeta.description}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!title.trim()}>Create file</button>
        </div>
      </form>
    </Modal>
  )
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-button" onClick={onClose} aria-label="Close modal">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
