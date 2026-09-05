// Wraps the existing synchronous localStorage functions to match
// SessionStore's async shape — no behavior change from before this feature.
import {
  clearAll, createProject, deleteProject, deleteSession,
  loadProjects, loadSessions, saveSession, updateProject,
} from './sessions'
import type { SessionStore } from './sessionStore'

export const localSessionStore: SessionStore = {
  loadSessions: async () => loadSessions(),
  saveSession: async session => saveSession(session),
  deleteSession: async id => deleteSession(id),
  loadProjects: async () => loadProjects(),
  createProject: async (name, description) => createProject(name, description),
  updateProject: async (id, patch) => updateProject(id, patch),
  deleteProject: async id => deleteProject(id),
  clearAll: async () => clearAll(),
}
