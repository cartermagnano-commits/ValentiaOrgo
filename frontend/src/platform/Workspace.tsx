'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, FlaskConical, FolderOpen, MessageSquare, Network, Trash2, X,
} from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import ChatPanel from './ChatPanel'
import NavRail from './NavRail'
import ChatsPage from './ChatsPage'
import ProjectsPage from './ProjectsPage'
import ProjectPage from './ProjectPage'
import SettingsPage from './SettingsPage'
import AccountPage from './AccountPage'
import { dayLabel } from './format'
import type { ChatContent, ChatMessage, ChatToolResult, SessionContent, Tool } from '../types'
import {
  Project,
  Session,
  View,
  createSession,
  hasRealContent,
  loadUiState,
  saveUiState,
} from '../../lib/sessions'
import { useAuth } from '../../lib/auth'

const TOOLS: Array<{ tool: Tool; label: string; icon: typeof Network; blurb: string }> = [
  { tool: 'synthesis', label: 'Synthesis', icon: Network, blurb: 'Explore reagent routes from a starting molecule' },
  { tool: 'direct_reaction', label: 'Reaction', icon: FlaskConical, blurb: 'Type molecules or photograph a reaction — the engine predicts products' },
  { tool: 'chat', label: 'Chat', icon: MessageSquare, blurb: 'Ask anything, attach images or files' },
]

function toolMeta(tool: Tool) {
  return TOOLS.find(t => t.tool === tool) ?? TOOLS[0]
}

export default function Workspace() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [view, setView] = useState<View>('tool')
  const [active, setActive] = useState<Session | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Live selection context pushed up by PathwayExplorer for the drawer.
  const [synthesisContext, setSynthesisContext] = useState<Record<string, unknown> | null>(null)

  const { user, store } = useAuth()

  // localStorage/Supabase reads aren't available synchronously — load once
  // on mount, and again whenever the active store changes (sign-in/sign-out
  // swap it), restoring whatever the user was last looking at.
  useEffect(() => {
    let cancelled = false
    async function hydrate() {
      const [storedSessions, storedProjects] = await Promise.all([
        store.loadSessions(), store.loadProjects(),
      ])
      if (cancelled) return
      setSessions(storedSessions)
      setProjects(storedProjects)

      const ui = loadUiState()
      // A project that has since been deleted must not resurrect a filtered view.
      const projectId = ui?.projectId && storedProjects.some(p => p.id === ui.projectId)
        ? ui.projectId : null
      // Empty sessions are never persisted, so a missing id just means the last
      // session held no work — reopen its tool with a fresh one.
      const restored = ui?.sessionId ? storedSessions.find(s => s.id === ui.sessionId) : undefined

      setActiveProjectId(projectId)
      // The project page needs a project; without one, fall back to the list.
      setView(ui?.view === 'project' && !projectId ? 'projects' : ui?.view ?? 'tool')
      setSidebarOpen(ui?.sidebarOpen ?? false)
      setActive(restored ?? createSession(ui?.tool ?? 'chat', projectId))
      setHydrated(true)
    }
    hydrate()
    return () => { cancelled = true }
  }, [store])

  const activeRef = useRef(active)
  activeRef.current = active

  // Remember where the user is for the next page load. Keyed on id/tool rather
  // than the session object, which is replaced on every streamed token.
  useEffect(() => {
    if (!hydrated || !active) return
    saveUiState({ sessionId: active.id, tool: active.tool, view, projectId: activeProjectId, sidebarOpen })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, active?.id, active?.tool, view, activeProjectId, sidebarOpen])

  async function persistIfReal(session: Session): Promise<Session> {
    if (!hasRealContent(session)) return session
    const saved = await store.saveSession(session)
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
      // Fire-and-forget: a cleanup function can't be awaited.
      if (latest && hasRealContent(latest)) store.saveSession(latest).catch(() => {})
    }
  }, [store])

  // Tool-save callback (PathwayExplorer calls onSave with partial data on
  // explicit saves; merge over the current content).
  function mergeAndSave(data: Record<string, unknown>) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content: { ...(current.content as Record<string, unknown>), ...data } as SessionContent }
    setActive(next)
    persistIfReal(next).then(setActive)
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

  function startTool(tool: Tool, projectId: string | null = activeProjectId) {
    setView('tool')
    setDrawerOpen(false)
    setSynthesisContext(null)
    setActiveProjectId(projectId)
    setActive(createSession(tool, projectId))
  }

  function openSession(session: Session) {
    setView('tool')
    setDrawerOpen(false)
    setSynthesisContext(null)
    setActiveProjectId(session.projectId ?? null)
    setActive(session)
  }

  async function removeSession(session: Session) {
    if (!window.confirm(`Delete "${session.title || 'this session'}"?`)) return
    await store.deleteSession(session.id)
    setSessions(prev => prev.filter(s => s.id !== session.id))
    if (active?.id === session.id) setActive(createSession(session.tool, activeProjectId))
  }

  async function handleCreateProject(name: string, description: string) {
    const project = await store.createProject(name, description)
    setProjects(prev => [project, ...prev])
    setActiveProjectId(project.id)
    setView('project')
  }

  async function handleDeleteProject(project: Project) {
    if (!window.confirm(`Delete project "${project.name}"? Its chats are kept in Chats.`)) return
    await store.deleteProject(project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setSessions(await store.loadSessions())
    if (activeProjectId === project.id) {
      setActiveProjectId(null)
      if (view === 'project') setView('projects')
    }
  }

  function openProject(project: Project) {
    setActiveProjectId(project.id)
    setView('project')
  }

  async function handleClearAll() {
    const message = user
      ? 'Delete every chat and project in your account? This cannot be undone.'
      : 'Delete every chat and project stored in this browser? This cannot be undone.'
    if (!window.confirm(message)) return
    await store.clearAll()
    setSessions([])
    setProjects([])
    setActiveProjectId(null)
    setActive(createSession('chat', null))
    setView('tool')
  }

  // Chats page shows only loose work; project work lives on its project page.
  const looseSessions = useMemo(() => sessions.filter(s => !s.projectId), [sessions])

  const projectSessions = useMemo(
    () => (activeProjectId ? sessions.filter(s => s.projectId === activeProjectId) : []),
    [sessions, activeProjectId],
  )

  // A project's "last updated" is really its most recent chat — sort on that
  // rather than on when the folder itself was last renamed.
  const projectsByActivity = useMemo(() => projects.map(project => {
    const latest = sessions.find(s => s.projectId === project.id)?.updatedAt
    return latest && latest > project.updatedAt ? { ...project, updatedAt: latest } : project
  }), [projects, sessions])

  // The recents panel follows the current context: inside a project it shows
  // that project's chats, otherwise everything.
  const recents = useMemo(
    () => (activeProjectId ? projectSessions : sessions),
    [activeProjectId, projectSessions, sessions],
  )

  const groupedRecents = useMemo(() => {
    const groups: Array<{ label: string; items: Session[] }> = []
    for (const session of recents) {
      const label = dayLabel(session.updatedAt)
      const group = groups.find(g => g.label === label)
      if (group) group.items.push(session)
      else groups.push({ label, items: [session] })
    }
    return groups
  }, [recents])

  if (!hydrated || !active) return null

  const content = active.content as Record<string, unknown>
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null
  // Reaction is now itself a chat surface — the drawer only exists on Synthesis.
  const showDrawerButton = view === 'tool' && active.tool === 'synthesis'
  const assistantMessages: ChatMessage[] = Array.isArray(content.assistantMessages)
    ? (content.assistantMessages as ChatMessage[]) : []

  return (
    <div className="app-shell">
      <NavRail
        view={view}
        tool={active.tool}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(open => !open)}
        onNewChat={() => startTool('chat')}
        onTool={startTool}
        onView={next => {
          setDrawerOpen(false)
          // "Projects" always returns to the list, never to the last project.
          if (next === 'projects') setActiveProjectId(null)
          setView(next)
        }}
      />

      {sidebarOpen && (
        <aside className="side-panel">
          <div className="side-panel-head">
            <span className="brand-word">Orgo AI</span>
          </div>
          {activeProject && (
            <div className="project-pill">
              <FolderOpen size={13} />
              <span className="history-title">{activeProject.name}</span>
              <button
                className="chat-chip-remove"
                title="Show all work"
                aria-label="Leave project view"
                onClick={() => { setActiveProjectId(null); if (view === 'project') setView('projects') }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="side-panel-label">Recents</div>
          {!recents.length && (
            <div className="history-empty">
              {activeProject
                ? 'Nothing in this project yet — start a chat and it lands here.'
                : 'Your work saves here automatically — no accounts, no files to manage.'}
            </div>
          )}
          {groupedRecents.map(group => (
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
      )}

      {view === 'chats' && (
        <main className="workspace-main page-main">
          <ChatsPage
            sessions={looseSessions}
            toolMeta={toolMeta}
            onOpen={openSession}
            onDelete={removeSession}
            onNewChat={() => startTool('chat', null)}
          />
        </main>
      )}

      {view === 'projects' && (
        <main className="workspace-main page-main">
          <ProjectsPage
            projects={projectsByActivity}
            countFor={id => sessions.filter(s => s.projectId === id).length}
            onOpen={openProject}
            onCreate={handleCreateProject}
            onDelete={handleDeleteProject}
          />
        </main>
      )}

      {view === 'project' && activeProject && (
        <main className="workspace-main page-main">
          <ProjectPage
            project={activeProject}
            sessions={projectSessions}
            toolMeta={toolMeta}
            onBack={() => { setActiveProjectId(null); setView('projects') }}
            onOpen={openSession}
            onDeleteSession={removeSession}
            onNew={tool => startTool(tool, activeProject.id)}
            onEdit={async patch => {
              const updated = await store.updateProject(activeProject.id, patch)
              if (updated) setProjects(prev => prev.map(p => (p.id === updated.id ? updated : p)))
            }}
          />
        </main>
      )}

      {view === 'settings' && (
        <main className="workspace-main page-main">
          <SettingsPage sessions={sessions} projects={projects} onClearAll={handleClearAll} />
        </main>
      )}

      {view === 'account' && (
        <main className="workspace-main page-main">
          <AccountPage />
        </main>
      )}

      {view === 'tool' && (
        <main className={`workspace-main${active.tool === 'synthesis' ? ' synthesis-main' : ' chat-main'}`}>
          {activeProject && (
            <div className="tool-context-bar">
              <FolderOpen size={13} />
              <button className="tool-context-link" onClick={() => setView('project')}>
                {activeProject.name}
              </button>
              <button
                className="chat-chip-remove"
                title="New work won’t be filed in this project"
                aria-label={`Leave project ${activeProject.name}`}
                onClick={() => setActiveProjectId(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
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
  )
}
