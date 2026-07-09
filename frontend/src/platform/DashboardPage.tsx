'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock3, FileText, FolderKanban, Plus, Trash2, Wand2 } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import {
  createProject, deleteProject, fetchProjects, getCurrentUser,
  createChemistryFile, updateChemistryFileContent, loadEngineSettings,
} from '../../lib/database'
import { isSupabaseConfigured } from '../../lib/supabaseClient'
import type { Project } from '../types'
import AppTopbar from './AppTopbar'
import Modal from './Modal'
import { useToast } from './Toast'
import { statusText } from './format'

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [creatingExample, setCreatingExample] = useState(false)
  const { notify } = useToast()

  function openNewProject() {
    setModalOpen(true)
  }

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
      // First-time users (no saved engine settings yet) go through onboarding:
      // choose an engine once, then land back here. Best-effort — if the
      // settings table isn't reachable we just show the dashboard.
      try {
        const engine = await loadEngineSettings(currentUser.id)
        if (!engine) {
          router.replace('/settings?onboarding=1')
          return
        }
      } catch {
        /* table missing or offline — skip onboarding gate */
      }
      if (cancelled) return
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
    notify('Project created', 'success')
    router.push(`/projects/${project.id}`)
  }

  async function handleDeleteProject(project: Project) {
    if (!user) return
    const ok = window.confirm(`Delete "${project.name}" and all chemistry files inside it?`)
    if (!ok) return
    try {
      await deleteProject(project.id, user.id)
      setProjects(prev => prev.filter(item => item.id !== project.id))
      notify('Project deleted', 'success')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not delete project.', 'error')
    }
  }

  async function handleCreateExample() {
    if (!user || creatingExample) return
    setCreatingExample(true)
    try {
      const project = await createProject(
        user.id,
        'Example: Enolate Chemistry',
        'A sample synthesis project to explore how Orgo AI works.',
      )
      const file = await createChemistryFile(project.id, user.id, '2-Pentanone → enolates', 'synthesis')
      // Pre-fill the substrate so the pathway is one click away.
      await updateChemistryFileContent(file.id, project.id, user.id, {
        ...(file.content as Record<string, unknown>),
        startingMaterials: ['CC(=O)CCC'],
        targetMolecule: '',
      } as typeof file.content)
      notify('Example project created', 'success')
      router.push(`/projects/${project.id}`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not create example.', 'error')
      setCreatingExample(false)
    }
  }

  if (loading) {
    return (
      <div className="platform-app">
        <AppTopbar compact />
        <main className="dashboard-page">
          <div className="dashboard-header">
            <div>
              <div className="eyebrow">Projects</div>
              <h2>Chemistry workspaces</h2>
            </div>
          </div>
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-card" />
            ))}
          </div>
        </main>
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
          </div>
          <button className="btn-primary action-button" onClick={() => openNewProject()}>
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
              <p>New here? Start with a worked example, or create your own workspace for a
                homework set, synthesis plan, or research compound.</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button className="btn-primary action-button" onClick={handleCreateExample} disabled={creatingExample}>
                  <Wand2 size={16} />
                  {creatingExample ? 'Creating…' : 'Try an example project'}
                </button>
                <button className="btn-secondary action-button" onClick={() => openNewProject()}>
                  <Plus size={16} />
                  New Project
                </button>
              </div>
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
                <h3>{project.name}</h3>
                {project.description && <p>{project.description}</p>}
              </div>
              <div className="project-card-meta">
                <span><FileText size={13} /> {project.fileCount ?? 0} file{project.fileCount === 1 ? '' : 's'}</span>
                <span><Clock3 size={13} /> {statusText(project.updated_at)}</span>
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
          <span>Description <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></span>
          <textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} />
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
