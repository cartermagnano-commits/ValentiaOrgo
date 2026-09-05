// The storage backend Workspace.tsx reads/writes through — one
// implementation per account state. Signed out uses localSessionStore
// (frontend/lib/sessions.ts, unchanged); signed in uses a
// makeCloudSessionStore(userId) built on Supabase + RLS. Workspace never
// calls lib/sessions.ts's storage functions directly once this lands — see
// docs/superpowers/specs/2026-09-04-user-profiles-design.md.
import type { Project, Session } from './sessions'

export interface SessionStore {
  loadSessions(): Promise<Session[]>
  saveSession(session: Session): Promise<Session>
  deleteSession(id: string): Promise<void>
  loadProjects(): Promise<Project[]>
  createProject(name: string, description?: string): Promise<Project>
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description'>>): Promise<Project | null>
  deleteProject(id: string): Promise<void>
  clearAll(): Promise<void>
}
