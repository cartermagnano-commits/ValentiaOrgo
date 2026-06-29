import type { User } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'
import { makeInitialContent } from './content'
import type { ChemistryFile, ChemistryFileContent, ChemistryFileType, Project } from '../src/types'

type ProjectRow = Omit<Project, 'fileCount'> & {
  fileCount?: number
}

export async function getCurrentUser(): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user
}

export async function fetchProjects(userId: string): Promise<Project[]> {
  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) throw error

  const { data: fileRows, error: fileError } = await supabase
    .from('chemistry_files')
    .select('project_id')
    .eq('user_id', userId)

  if (fileError) throw fileError

  const counts = new Map<string, number>()
  for (const row of fileRows ?? []) {
    counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1)
  }

  return ((projects ?? []) as ProjectRow[]).map(project => ({
    ...project,
    fileCount: counts.get(project.id) ?? 0,
  }))
}

export async function createProject(userId: string, name: string, description: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ user_id: userId, name, description: description || null })
    .select('*')
    .single()

  if (error) throw error
  return { ...(data as Project), fileCount: 0 }
}

export async function deleteProject(projectId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', userId)

  if (error) throw error
}

export async function fetchProject(projectId: string, userId: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data as Project | null
}

export async function fetchProjectFiles(projectId: string, userId: string): Promise<ChemistryFile[]> {
  const { data, error } = await supabase
    .from('chemistry_files')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as ChemistryFile[]
}

export async function createChemistryFile(
  projectId: string,
  userId: string,
  title: string,
  type: ChemistryFileType,
): Promise<ChemistryFile> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('chemistry_files')
    .insert({
      project_id: projectId,
      user_id: userId,
      title,
      type,
      content: makeInitialContent(type),
    })
    .select('*')
    .single()

  if (error) throw error
  await touchProject(projectId, userId, now)
  return data as ChemistryFile
}

export async function updateChemistryFileContent(
  fileId: string,
  projectId: string,
  userId: string,
  content: ChemistryFileContent,
): Promise<ChemistryFile> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('chemistry_files')
    .update({ content, updated_at: now })
    .eq('id', fileId)
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error) throw error
  await touchProject(projectId, userId, now)
  return data as ChemistryFile
}

export async function deleteChemistryFile(fileId: string, projectId: string, userId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('chemistry_files')
    .delete()
    .eq('id', fileId)
    .eq('project_id', projectId)
    .eq('user_id', userId)

  if (error) throw error
  await touchProject(projectId, userId, now)
}

async function touchProject(projectId: string, userId: string, updatedAt: string): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ updated_at: updatedAt })
    .eq('id', projectId)
    .eq('user_id', userId)

  if (error) throw error
}
