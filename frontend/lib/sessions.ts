// Local session store — the app's only persistence. Sessions live in
// localStorage: no accounts, no cloud, nothing to set up. One session is one
// piece of work (a synthesis exploration, a reaction, a conversation).

import type { SessionContent, Tool } from '../src/types'

export type Session = {
  id: string
  tool: Tool
  title: string
  createdAt: string
  updatedAt: string
  content: SessionContent
  projectId?: string | null
}

export type Project = {
  id: string
  name: string
  /** Free-text "what this project is about" shown on the project card. */
  description?: string
  createdAt: string
  updatedAt: string
}

const STORE_KEY = 'orgo.sessions.v1'
const PROJECTS_KEY = 'orgo.projects.v1'
const UI_STATE_KEY = 'orgo.ui.v1'

export function makeInitialContent(tool: Tool): SessionContent {
  if (tool === 'synthesis') return { targetMolecule: '', startingMaterials: [], pathwaysData: null }
  // Reaction sessions are chat-shaped: the conversation IS the workspace
  // (typed molecules or a photo, engine results as cards in the thread).
  return { messages: [] }
}

// A session earns a slot in history only once it holds real work — otherwise
// every accidental tab click would leave an empty row behind.
export function hasRealContent(session: Session): boolean {
  const c = session.content as Record<string, unknown>
  // Drawer-assistant conversations count as work even before molecules go in.
  if (Array.isArray(c.assistantMessages) && c.assistantMessages.length > 0) return true
  if (session.tool === 'synthesis') {
    return Boolean(c.pathwaysData)
      || Boolean((c.targetMolecule as string || '').trim())
      || (Array.isArray(c.startingMaterials) && c.startingMaterials.some(s => String(s).trim()))
  }
  // chat and direct_reaction are both conversation-shaped
  return Array.isArray(c.messages) && c.messages.length > 0
}

// Derive the sidebar title from the work itself, so users never name anything.
export function autoTitle(session: Session): string {
  const c = session.content as Record<string, unknown>
  const clip = (s: string, n = 42) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  if (session.tool === 'synthesis') {
    const target = String(c.targetMolecule ?? '').trim()
    const starts = Array.isArray(c.startingMaterials)
      ? c.startingMaterials.map(s => String(s).trim()).filter(Boolean) : []
    if (target && starts.length) return clip(`${starts[0]} → ${target}`)
    if (target) return clip(`→ ${target}`)
    if (starts.length) return clip(starts[0])
    if (Array.isArray(c.assistantMessages) && c.assistantMessages.length) return 'Synthesis chat'
    return 'New synthesis'
  }
  const first = (c.messages as Array<{ role: string; content: string }> | undefined)
    ?.find(m => m.role === 'user' && m.content.trim())
  if (first) return clip(first.content.trim())
  return session.tool === 'direct_reaction' ? 'New reaction' : 'New chat'
}

export function loadSessions(): Session[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // Newest first: every list in the app (recents, Chats, a project's page)
    // groups by day, so an out-of-order store would show days out of order.
    return parsed.sort((a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

function persist(sessions: Session[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(sessions))
  } catch (err) {
    // Quota exceeded (usually image-heavy chats). Drop the oldest sessions
    // until it fits rather than silently losing the newest work.
    const trimmed = [...sessions]
    while (trimmed.length > 1) {
      trimmed.pop()
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(trimmed))
        return
      } catch { /* keep trimming */ }
    }
    throw err
  }
}

export function saveSession(session: Session): Session {
  const updated: Session = { ...session, title: autoTitle(session), updatedAt: new Date().toISOString() }
  const rest = loadSessions().filter(s => s.id !== session.id)
  persist([updated, ...rest])
  return updated
}

export function deleteSession(id: string): void {
  persist(loadSessions().filter(s => s.id !== id))
}

// Settings' "delete everything" — the local store is the only copy, so this is
// destructive and the caller must confirm first.
export function clearAll(): void {
  try {
    window.localStorage.removeItem(STORE_KEY)
    window.localStorage.removeItem(PROJECTS_KEY)
    window.localStorage.removeItem(UI_STATE_KEY)
  } catch { /* nothing else to do if storage is unavailable */ }
}

function makeId(prefix: string): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function createSession(tool: Tool, projectId?: string | null): Session {
  const now = new Date().toISOString()
  return {
    id: makeId('s'),
    tool,
    title: '',
    createdAt: now,
    updatedAt: now,
    content: makeInitialContent(tool),
    ...(projectId ? { projectId } : {}),
  }
}

// ── UI state: what the user was looking at, so a refresh doesn't lose it ─────

// Which page the shell is showing. 'tool' is the workspace itself (a chat,
// reaction or synthesis session); the rest are nav-rail destinations.
export type View = 'tool' | 'chats' | 'projects' | 'project' | 'settings'

export type UiState = {
  sessionId: string | null
  tool: Tool
  view: View
  projectId: string | null
  /** Whether the recents panel next to the rail is pinned open. */
  sidebarOpen?: boolean
}

const TOOLS: Tool[] = ['synthesis', 'direct_reaction', 'chat']
const VIEWS: View[] = ['tool', 'chats', 'projects', 'project', 'settings']

export function loadUiState(): UiState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UiState>
    // Anything unrecognised falls back to the old default (a fresh chat).
    if (!parsed || typeof parsed !== 'object') return null
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      tool: TOOLS.includes(parsed.tool as Tool) ? (parsed.tool as Tool) : 'chat',
      view: VIEWS.includes(parsed.view as View) ? (parsed.view as View) : 'tool',
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      sidebarOpen: parsed.sidebarOpen === true,
    }
  } catch {
    return null
  }
}

export function saveUiState(state: UiState): void {
  try {
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(state))
  } catch { /* the UI state is tiny; a failed write just costs us the restore */ }
}

// ── Projects: lightweight local grouping for sessions ────────────────────────

export function loadProjects(): Project[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PROJECTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // Projects written before descriptions/updatedAt existed still load.
    return parsed.map((p: Project) => ({ ...p, updatedAt: p.updatedAt ?? p.createdAt }))
  } catch {
    return []
  }
}

function persistProjects(projects: Project[]): void {
  try {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  } catch { /* projects are tiny; a failed write just loses the grouping */ }
}

export function createProject(name: string, description = ''): Project {
  const now = new Date().toISOString()
  const project: Project = {
    id: makeId('p'),
    name: name.trim(),
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
  }
  persistProjects([project, ...loadProjects()])
  return project
}

// Edits (rename, re-describe) and any activity inside a project bump its
// updatedAt, which is what the Projects page sorts on by default.
export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description'>>): Project | null {
  const projects = loadProjects()
  const project = projects.find(p => p.id === id)
  if (!project) return null
  const updated: Project = {
    ...project,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    updatedAt: new Date().toISOString(),
  }
  persistProjects(projects.map(p => (p.id === id ? updated : p)))
  return updated
}

// Deleting a project keeps its sessions — they just return to the ungrouped
// history rather than losing work.
export function deleteProject(id: string): void {
  persistProjects(loadProjects().filter(p => p.id !== id))
  const sessions = loadSessions()
  let changed = false
  for (const session of sessions) {
    if (session.projectId === id) {
      delete session.projectId
      changed = true
    }
  }
  if (changed) persist(sessions)
}
