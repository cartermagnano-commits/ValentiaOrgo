// Supabase-backed SessionStore — one instance per signed-in user id. Every
// query is scoped by Row Level Security (auth.uid() = user_id), enforced in
// Postgres regardless of what this code sends; see supabase/schema.sql and
// test_supabase_rls.py.
import { supabase } from './supabase'
import { autoTitle } from './sessions'
import type { Project, Session } from './sessions'
import type { SessionStore } from './sessionStore'

type ChemistryFileRow = {
  id: string
  project_id: string | null
  title: string
  type: Session['tool']
  content: Session['content']
  created_at: string
  updated_at: string
}

type ProjectRow = {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

function rowToSession(row: ChemistryFileRow): Session {
  return {
    id: row.id,
    tool: row.type,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    content: row.content,
    projectId: row.project_id,
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function makeCloudSessionStore(userId: string): SessionStore {
  return {
    async loadSessions() {
      const { data, error } = await supabase
        .from('chemistry_files')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return (data as ChemistryFileRow[]).map(rowToSession)
    },

    async saveSession(session) {
      const title = autoTitle(session)
      const { data, error } = await supabase
        .from('chemistry_files')
        .upsert({
          id: session.id,
          user_id: userId,
          project_id: session.projectId ?? null,
          title,
          type: session.tool,
          content: session.content,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw error
      return rowToSession(data as ChemistryFileRow)
    },

    async deleteSession(id) {
      const { error } = await supabase.from('chemistry_files').delete().eq('id', id)
      if (error) throw error
    },

    async loadProjects() {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return (data as ProjectRow[]).map(rowToProject)
    },

    async createProject(name, description = '') {
      const { data, error } = await supabase
        .from('projects')
        .insert({ user_id: userId, name: name.trim(), description: description.trim() })
        .select()
        .single()
      if (error) throw error
      return rowToProject(data as ProjectRow)
    },

    async updateProject(id, patch) {
      const { data, error } = await supabase
        .from('projects')
        .update({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single()
      if (error) return null
      return rowToProject(data as ProjectRow)
    },

    async deleteProject(id) {
      // No manual "ungroup" step needed: chemistry_files.project_id is
      // `on delete set null` (supabase/schema.sql), so Postgres does it.
      const { error } = await supabase.from('projects').delete().eq('id', id)
      if (error) throw error
    },

    async clearAll() {
      const { error: filesError } = await supabase
        .from('chemistry_files').delete().eq('user_id', userId)
      if (filesError) throw filesError
      const { error: projectsError } = await supabase
        .from('projects').delete().eq('user_id', userId)
      if (projectsError) throw projectsError
    },
  }
}
