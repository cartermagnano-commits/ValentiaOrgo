'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Beaker, Bot, FlaskConical, FolderKanban, FolderOpen,
  MessageSquare, Network, Plus, Trash2, X,
} from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import ChatPanel from './ChatPanel'
import type { ChatContent, ChatMessage, ChatToolResult, SessionContent, Tool } from '../types'
import {
  Project,
  Session,
  createProject,
  createSession,
  deleteProject,
  deleteSession,
  hasRealContent,
  loadProjects,
  loadSessions,
  saveSession,
} from '../../lib/sessions'

const TOOLS: Array<{ tool: Tool; label: string; icon: typeof Network; blurb: string }> = [
  { tool: 'synthesis', label: 'Synthesis', icon: Network, blurb: 'Explore reagent routes from a starting molecule' },
  { tool: 'direct_reaction', label: 'Reaction', icon: FlaskConical, blurb: 'Type molecules or photograph a reaction — the engine predicts products' },
  { tool: 'chat', label: 'Chat', icon: MessageSquare, blurb: 'Ask anything, attach images or files' },
]

function toolMeta(tool: Tool) {
  return TOOLS.find(t => t.tool === tool) ?? TOOLS[0]
}

// Sidebar grouping: Today / Yesterday / "Jul 28"
function dayLabel(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function Workspace() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [view, setView] = useState<'tool' | 'projects'>('tool')
  const [active, setActive] = useState<Session | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  // Live selection context pushed up by PathwayExplorer for the drawer.
  const [synthesisContext, setSynthesisContext] = useState<Record<string, unknown> | null>(null)

  // localStorage isn't available during SSR — load once on mount, then start
  // a fresh chat session so the app opens ready to use.
  useEffect(() => {
    setSessions(loadSessions())
    setProjects(loadProjects())
    setActive(createSession('chat'))
    setHydrated(true)
  }, [])

  const activeRef = useRef(active)
  activeRef.current = active

  function persistIfReal(session: Session) {
    if (!hasRealContent(session)) return session
    const saved = saveSession(session)
    setSessions(prev => [saved, ...prev.filter(s => s.id !== saved.id)])
    return saved
  }

  // Debounced persist: chat streaming calls updateContent per token, and
  // serializing every session to localStorage on each delta would jank the UI.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateContent(content: SessionContent) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content }
    setActive(next)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const latest = activeRef.current
      if (latest && latest.id === next.id) persistIfReal(latest)
    }, 400)
  }

  useEffect(() => () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      const latest = activeRef.current
      if (latest && hasRealContent(latest)) saveSession(latest)
    }
  }, [])

  // Tool-save callback (PathwayExplorer calls onSave with partial data on
  // explicit saves; merge over the current content).
  function mergeAndSave(data: Record<string, unknown>) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content: { ...(current.content as Record<string, unknown>), ...data } as SessionContent }
    setActive(persistIfReal(next))
  }

  // PathwayExplorer owns its state after mount, so chat-driven changes to the
  // stockroom/pathways need a remount to take effect — bump this to force one.
  const [synthesisRevision, setSynthesisRevision] = useState(0)

  // Chat tool events that change the app outside the conversation.
  function handleUiEvent(event: ChatToolResult) {
    const current = activeRef.current
    if (!current || current.tool !== 'synthesis') return
    const currentContent = current.content as Record<string, unknown>
    if (event.type === 'set_stockroom') {
      const data = event.data as { smiles?: string[]; mode?: string }
      const incoming = data.smiles ?? []
      const existing = Array.isArray(currentContent.startingMaterials)
        ? (currentContent.startingMaterials as string[]).filter(s => s.trim()) : []
      const merged = data.mode === 'add'
        ? [...existing, ...incoming.filter(s => !existing.includes(s))]
        : incoming
      mergeAndSave({ startingMaterials: merged.slice(0, 4) })
      setSynthesisRevision(r => r + 1)
    }
    if (event.type === 'pathways_result') {
      const data = event.data as { start_smiles?: string[]; target_smiles?: string; pathways?: unknown }
      mergeAndSave({
        startingMaterials: data.start_smiles ?? [],
        targetMolecule: data.target_smiles ?? '',
        pathwaysData: data.pathways ?? null,
      })
      setSynthesisRevision(r => r + 1)
    }
  }

  function startTool(tool: Tool) {
    setView('tool')
    setDrawerOpen(false)
    setSynthesisContext(null)
    setActive(createSession(tool, activeProjectId))
  }

  function openSession(session: Session) {
    setView('tool')
    setDrawerOpen(false)
    setSynthesisContext(null)
    setActive(session)
  }

  function removeSession(session: Session) {
    if (!window.confirm(`Delete "${session.title || 'this session'}"?`)) return
    deleteSession(session.id)
    setSessions(prev => prev.filter(s => s.id !== session.id))
    if (active?.id === session.id) setActive(createSession(session.tool, activeProjectId))
  }

  function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name) return
    const project = createProject(name)
    setProjects(prev => [project, ...prev])
    setNewProjectName('')
    setActiveProjectId(project.id)
    setView('tool')
    setActive(createSession('chat', project.id))
  }

  function handleDeleteProject(project: Project) {
    if (!window.confirm(`Delete project "${project.name}"? Its sessions are kept in History.`)) return
    deleteProject(project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setSessions(loadSessions())
    if (activeProjectId === project.id) setActiveProjectId(null)
  }

  function openProject(project: Project) {
    setActiveProjectId(project.id)
    setView('tool')
    const recent = sessions.find(s => s.projectId === project.id)
    if (recent) openSession(recent)
    else setActive(createSession('chat', project.id))
  }

  const visibleSessions = useMemo(
    () => (activeProjectId ? sessions.filter(s => s.projectId === activeProjectId) : sessions),
    [sessions, activeProjectId],
  )

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: Session[] }> = []
    for (const session of visibleSessions) {
      const label = dayLabel(session.updatedAt)
      const group = groups.find(g => g.label === label)
      if (group) group.items.push(session)
      else groups.push({ label, items: [session] })
    }
    return groups
  }, [visibleSessions])

  if (!hydrated || !active) return null

  const content = active.content as Record<string, unknown>
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null
  // Reaction is now itself a chat surface — the drawer only exists on Synthesis.
  const showDrawerButton = view === 'tool' && active.tool === 'synthesis'
  const assistantMessages: ChatMessage[] = Array.isArray(content.assistantMessages)
    ? (content.assistantMessages as ChatMessage[]) : []

  return (
    <div className="workspace-app">
      <header className="workspace-topbar">
        <div className="workspace-brand">
          <div className="brand-mark"><Beaker size={18} /></div>
          <h1>Orgo AI</h1>
        </div>
        <nav className="workspace-tabs" aria-label="Tools">
          {TOOLS.map(({ tool, label, icon: Icon, blurb }) => (
            <button
              key={tool}
              className={`workspace-tab${view === 'tool' && active.tool === tool ? ' active' : ''}`}
              title={blurb}
              onClick={() => startTool(tool)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
          <span className="workspace-tab-divider" aria-hidden="true" />
          <button
            className={`workspace-tab${view === 'projects' ? ' active' : ''}`}
            title="Group your work into projects"
            onClick={() => setView('projects')}
          >
            <FolderKanban size={15} />
            Projects
          </button>
        </nav>
      </header>

      <div className="workspace-columns">
        <aside className="history-sidebar">
          {activeProject ? (
            <div className="project-pill">
              <FolderOpen size={13} />
              <span className="history-title">{activeProject.name}</span>
              <button
                className="chat-chip-remove"
                title="Show all work"
                aria-label="Leave project view"
                onClick={() => setActiveProjectId(null)}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <div className="history-heading">History</div>
          )}
          {!visibleSessions.length && (
            <div className="history-empty">
              {activeProject
                ? 'Nothing in this project yet — start a tool above and your work lands here.'
                : 'Your work saves here automatically — no accounts, no files to manage.'}
            </div>
          )}
          {grouped.map(group => (
            <div key={group.label} className="history-group">
              <div className="history-day">{group.label}</div>
              {group.items.map(session => {
                const meta = toolMeta(session.tool)
                const Icon = meta.icon
                return (
                  <div
                    key={session.id}
                    className={`history-item${view === 'tool' && active.id === session.id ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openSession(session)}
                    onKeyDown={event => { if (event.key === 'Enter') openSession(session) }}
                  >
                    <Icon size={14} />
                    <span className="history-title">{session.title || meta.label}</span>
                    <button
                      className="history-delete"
                      aria-label={`Delete ${session.title || meta.label}`}
                      onClick={event => {
                        event.stopPropagation()
                        removeSession(session)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </aside>

        {view === 'projects' ? (
          <main className="workspace-main projects-main">
            <div className="projects-view">
              <h2>Projects</h2>
              <p className="projects-blurb">
                Group related work — a problem set, a lab, an exam topic. Opening a project
                filters your history to it, and new work is filed there automatically.
              </p>
              <div className="project-create-row">
                <input
                  type="text"
                  value={newProjectName}
                  placeholder="New project name…"
                  onChange={event => setNewProjectName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') handleCreateProject() }}
                />
                <button className="btn-primary action-button" onClick={handleCreateProject} disabled={!newProjectName.trim()}>
                  <Plus size={15} />
                  Create
                </button>
              </div>
              {!projects.length && (
                <div className="history-empty" style={{ padding: '14px 2px' }}>
                  No projects yet. Everything still saves to History — projects are just folders on top.
                </div>
              )}
              <div className="project-grid">
                {projects.map(project => {
                  const count = sessions.filter(s => s.projectId === project.id).length
                  return (
                    <div key={project.id} className="project-card" role="button" tabIndex={0}
                      onClick={() => openProject(project)}
                      onKeyDown={event => { if (event.key === 'Enter') openProject(project) }}
                    >
                      <div className="project-card-head">
                        <FolderOpen size={17} />
                        <button
                          className="history-delete project-delete"
                          aria-label={`Delete project ${project.name}`}
                          onClick={event => { event.stopPropagation(); handleDeleteProject(project) }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <strong>{project.name}</strong>
                      <small>{count} session{count !== 1 ? 's' : ''}</small>
                    </div>
                  )
                })}
              </div>
            </div>
          </main>
        ) : (
          <main className={`workspace-main${active.tool !== 'synthesis' ? ' chat-main' : ''}`}>
            {active.tool === 'synthesis' && (
              <PathwayExplorer
                key={`${active.id}_${synthesisRevision}`}
                initialSubstrate={Array.isArray(content.startingMaterials)
                  ? (content.startingMaterials as string[]).filter(Boolean)
                  : []}
                initialTarget={(content.targetMolecule as string) ?? ''}
                initialPathways={content.pathwaysData ?? null}
                onSave={(data: Record<string, unknown>) => mergeAndSave(data)}
                onContextChange={(ctx: Record<string, unknown> | null) => setSynthesisContext(ctx)}
              />
            )}
            {active.tool === 'direct_reaction' && (
              <ChatPanel
                key={active.id}
                content={{ messages: Array.isArray(content.messages) ? content.messages as ChatMessage[] : [] }}
                onChange={next => updateContent(next)}
                onSave={async next => { if (next) updateContent(next) }}
                saving={false}
                surface="reaction"
                enableReactionPhoto
                placeholder="Name your molecules, or photograph the reaction…"
                emptyTitle="What are we reacting?"
                emptyBlurb="Type the molecules ('react t-BuBr with NaOH'), or use the camera button to photograph a reaction like a textbook problem. The verified engine predicts the products; I explain them."
              />
            )}
            {active.tool === 'chat' && (
              <ChatPanel
                key={active.id}
                content={active.content as ChatContent}
                onChange={next => updateContent(next)}
                onSave={async next => { if (next) updateContent(next) }}
                saving={false}
                surface="chat"
              />
            )}

            {showDrawerButton && !drawerOpen && (
              <button className="assistant-fab" onClick={() => setDrawerOpen(true)} title="Ask the assistant about this work">
                <Bot size={17} />
                Assistant
              </button>
            )}

            {showDrawerButton && drawerOpen && (
              <div className="assistant-drawer">
                <div className="assistant-drawer-header">
                  <Bot size={15} />
                  <strong>Assistant</strong>
                  <span className="assistant-drawer-hint">
                    {synthesisContext ? 'Grounded in the pathway on screen' : 'Can set your stockroom and run pathways'}
                  </span>
                  <button className="chat-chip-remove" aria-label="Close assistant" onClick={() => setDrawerOpen(false)}>
                    <X size={15} />
                  </button>
                </div>
                <ChatPanel
                  key={`${active.id}_assistant`}
                  content={{ messages: assistantMessages }}
                  onChange={next => updateContent({ ...(activeRef.current?.content as Record<string, unknown>), assistantMessages: next.messages } as SessionContent)}
                  onSave={async next => {
                    if (next) updateContent({ ...(activeRef.current?.content as Record<string, unknown>), assistantMessages: next.messages } as SessionContent)
                  }}
                  saving={false}
                  context={synthesisContext}
                  surface="synthesis"
                  onUiEvent={handleUiEvent}
                  placeholder="Set my stockroom to…, run pathways, explain this route…"
                  emptyTitle="Ask about this work"
                  emptyBlurb="I can set your stockroom, run pathway analysis, run reactions, and explain the routes on screen — just ask."
                />
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  )
}
