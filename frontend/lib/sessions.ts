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
  createdAt: string
}

const STORE_KEY = 'orgo.sessions.v1'
const PROJECTS_KEY = 'orgo.projects.v1'

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
    return parsed
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

// ── Projects: lightweight local grouping for sessions ────────────────────────

export function loadProjects(): Project[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PROJECTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistProjects(projects: Project[]): void {
  try {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  } catch { /* projects are tiny; a failed write just loses the grouping */ }
}

export function createProject(name: string): Project {
  const project: Project = { id: makeId('p'), name: name.trim(), createdAt: new Date().toISOString() }
  persistProjects([project, ...loadProjects()])
  return project
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
