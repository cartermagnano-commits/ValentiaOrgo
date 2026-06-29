'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, Clock3, FileText, FolderKanban, Plus, Trash2 } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { createProject, deleteProject, fetchProjects, getCurrentUser } from '../../lib/database'
import { isSupabaseConfigured } from '../../lib/supabaseClient'
import type { Project } from '../types'
import AppTopbar from './AppTopbar'
import Modal from './Modal'
import { formatDate, statusText } from './format'

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      const currentUser = await getCurrentUser()
      if (!currentUser) {
        router.replace('/login')
        return
      }
      if (cancelled) return
      setUser(currentUser)
      try {
        setProjects(await fetchProjects(currentUser.id))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load projects.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [router])

  async function handleCreateProject(payload: { name: string; description: string }) {
    if (!user) return
    const project = await createProject(user.id, payload.name, payload.description)
    setProjects(prev => [project, ...prev])
    setModalOpen(false)
    router.push(`/projects/${project.id}`)
  }

  async function handleDeleteProject(project: Project) {
    if (!user) return
    const ok = window.confirm(`Delete "${project.name}" and all chemistry files inside it?`)
    if (!ok) return
    await deleteProject(project.id, user.id)
    setProjects(prev => prev.filter(item => item.id !== project.id))
  }

  if (loading) {
    return (
      <div className="platform-app">
        <AppTopbar compact />
        <div className="page-loading">Loading projects...</div>
      </div>
    )
  }

  return (
    <div className="platform-app">
      <AppTopbar email={user?.email} />
      <main className="dashboard-page">
        <div className="dashboard-header">
          <div>
            <div className="eyebrow">Projects</div>
            <h2>Chemistry workspaces</h2>
            <p>Organize synthesis plans, homework sets, reaction predictions, and research notes by project.</p>
          </div>
          <button className="btn-primary action-button" onClick={() => setModalOpen(true)}>
            <Plus size={16} />
            New Project
          </button>
        </div>

        {!isSupabaseConfigured && (
          <div className="error-banner wide">
            Supabase environment variables are missing. Add them in `frontend/.env.local` before using saved accounts.
          </div>
        )}
        {error && <div className="error-banner wide">{error}</div>}

        <div className="project-grid">
          {!projects.length && !error && (
            <div className="dashboard-empty-state">
              <FolderKanban size={34} />
              <h3>No projects yet</h3>
              <p>Create a workspace for a homework set, synthesis plan, or research compound.</p>
              <button className="btn-primary action-button" onClick={() => setModalOpen(true)}>
                <Plus size={16} />
                New Project
              </button>
            </div>
          )}

          {projects.map(project => (
            <div
              key={project.id}
              className="project-card"
              onClick={() => router.push(`/projects/${project.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={event => {
                if (event.key === 'Enter') router.push(`/projects/${project.id}`)
              }}
            >
              <div className="project-card-icon">
                <FolderKanban size={20} />
              </div>
              <div className="project-card-main">
                <div className="project-status-row">
                  <span className="status-pill saved">Saved</span>
                  <span className="status-pill muted">{statusText(project.updated_at)}</span>
                </div>
                <h3>{project.name}</h3>
                <p>{project.description || 'No description yet.'}</p>
              </div>
              <div className="project-card-meta">
                <span><FileText size={13} /> {project.fileCount ?? 0} file{project.fileCount === 1 ? '' : 's'}</span>
                <span><CalendarDays size={13} /> Created {formatDate(project.created_at)}</span>
                <span><Clock3 size={13} /> Updated {formatDate(project.updated_at)}</span>
              </div>
              <button
                className="project-delete-button"
                aria-label={`Delete ${project.name}`}
                onClick={event => {
                  event.stopPropagation()
                  handleDeleteProject(project)
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </main>

      {modalOpen && (
        <NewProjectModal
          onClose={() => setModalOpen(false)}
          onCreate={handleCreateProject}
        />
      )}
    </div>
  )
}

function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (payload: { name: string; description: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError('')
    try {
      await onCreate({ name: name.trim(), description: description.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project.')
      setSaving(false)
    }
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
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || saving}>
            {saving ? 'Creating...' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
