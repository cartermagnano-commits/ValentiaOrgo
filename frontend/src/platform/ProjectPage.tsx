'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, LogOut, NotebookText, Plus, Trash2 } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabaseClient'
import {
  createChemistryFile,
  deleteChemistryFile,
  fetchProject,
  fetchProjectFiles,
  getCurrentUser,
} from '../../lib/database'
import type { ChemistryFile, ChemistryFileType, Project } from '../types'
import AppTopbar from './AppTopbar'
import FileEditor from './FileEditor'
import Modal from './Modal'
import { FILE_TYPES, fileTypeMeta } from './fileTypes'
import { statusText } from './format'

export default function ProjectPage({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [files, setFiles] = useState<ChemistryFile[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
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
        const [projectResult, fileResult] = await Promise.all([
          fetchProject(projectId, currentUser.id),
          fetchProjectFiles(projectId, currentUser.id),
        ])
        if (!projectResult) {
          setError('Project not found, or you do not have access to it.')
          return
        }
        setProject(projectResult)
        setFiles(fileResult)
        setActiveFileId(fileResult[0]?.id ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load project.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [projectId, router])

  const activeFile = files.find(file => file.id === activeFileId) ?? null

  async function handleCreateFile(payload: { title: string; type: ChemistryFileType }) {
    if (!user || !project) return
    const file = await createChemistryFile(project.id, user.id, payload.title, payload.type)
    setFiles(prev => [file, ...prev])
    setActiveFileId(file.id)
    setModalOpen(false)
  }

  async function handleDeleteFile(file: ChemistryFile) {
    if (!user || !project) return
    const ok = window.confirm(`Delete "${file.title}"?`)
    if (!ok) return
    await deleteChemistryFile(file.id, project.id, user.id)
    setFiles(prev => prev.filter(item => item.id !== file.id))
    if (activeFileId === file.id) {
      const remaining = files.filter(item => item.id !== file.id)
      setActiveFileId(remaining[0]?.id ?? null)
    }
  }

  function handleSavedFile(savedFile: ChemistryFile) {
    setFiles(prev => prev.map(file => file.id === savedFile.id ? savedFile : file))
  }

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) {
    return (
      <div className="platform-app">
        <AppTopbar compact />
        <div className="page-loading">Loading project...</div>
      </div>
    )
  }

  if (!project || error) {
    return (
      <div className="platform-app">
        <AppTopbar email={user?.email} />
        <main className="dashboard-page">
          <button className="icon-text-button" onClick={() => router.push('/dashboard')}>
            <ArrowLeft size={15} />
            Dashboard
          </button>
          <div className="error-state">
            <NotebookText size={34} />
            <h2>Project unavailable</h2>
            <p>{error || 'Project not found.'}</p>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="platform-app">
      <div className="project-workspace">
        <header className="project-header">
          <button className="icon-text-button" onClick={() => router.push('/dashboard')}>
            <ArrowLeft size={15} />
            Projects
          </button>
          <div>
            <h2>{project.name}</h2>
            <p>{project.description || 'No project description.'}</p>
          </div>
          <div className="project-header-actions">
            <span className="user-email">{user?.email}</span>
            <button className="btn-secondary action-button" onClick={logout}>
              <LogOut size={15} />
              Logout
            </button>
          </div>
        </header>

        <div className="workspace-body">
          <aside className="file-sidebar">
            <div className="file-sidebar-header">
              <div>
                <div className="eyebrow">Files</div>
                <strong>{files.length} saved</strong>
              </div>
              <button className="micro-button" onClick={() => setModalOpen(true)}>
                <Plus size={13} />
                New File
              </button>
            </div>

            <div className="file-list">
              {!files.length && (
                <div className="sidebar-empty-state">
                  <NotebookText size={28} />
                  <strong>No chemistry files</strong>
                  <span>Create the first saved operation for this project.</span>
                </div>
              )}
              {files.map(file => {
                const meta = fileTypeMeta(file.type)
                const Icon = meta.icon
                return (
                  <div
                    key={file.id}
                    className={`file-list-item${activeFile?.id === file.id ? ' active' : ''}`}
                    onClick={() => setActiveFileId(file.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={event => {
                      if (event.key === 'Enter') setActiveFileId(file.id)
                    }}
                  >
                    <Icon size={15} />
                    <span>
                      <strong>
                        {file.title}
                        <span className="file-type-badge">{meta.code}</span>
                      </strong>
                      <small>{statusText(file.updated_at)} · AI not run yet</small>
                    </span>
                    <button
                      className="file-delete-button"
                      aria-label={`Delete ${file.title}`}
                      onClick={event => {
                        event.stopPropagation()
                        handleDeleteFile(file)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          </aside>

          <main className="file-workspace">
            {activeFile && user ? (
              <FileEditor
                file={activeFile}
                files={files}
                userId={user.id}
                onSaved={handleSavedFile}
              />
            ) : (
              <EmptyFileState onNewFile={() => setModalOpen(true)} />
            )}
          </main>
        </div>
      </div>

      {modalOpen && (
        <NewFileModal
          onClose={() => setModalOpen(false)}
          onCreate={handleCreateFile}
        />
      )}
    </div>
  )
}

function EmptyFileState({ onNewFile }: { onNewFile: () => void }) {
  return (
    <div className="workspace-empty-state">
      <NotebookText size={38} />
      <h3>Select or create a file</h3>
      <p>Create a saved chemistry operation inside this project, or choose an existing file from the sidebar.</p>
      <button className="btn-primary action-button" onClick={onNewFile}>
        <Plus size={16} />
        New File
      </button>
    </div>
  )
}

function NewFileModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (payload: { title: string; type: ChemistryFileType }) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ChemistryFileType>('synthesis')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const selectedMeta = fileTypeMeta(type)
  const SelectedIcon = selectedMeta.icon

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    setError('')
    try {
      await onCreate({ title: title.trim(), type })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create file.')
      setSaving(false)
    }
  }

  return (
    <Modal title="New Chemistry File" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          <span>File title</span>
          <input value={title} onChange={event => setTitle(event.target.value)} autoFocus />
        </label>
        <label>
          <span>File type</span>
          <select value={type} onChange={event => setType(event.target.value as ChemistryFileType)}>
            {FILE_TYPES.map(item => (
              <option key={item.type} value={item.type}>{item.label}</option>
            ))}
          </select>
        </label>
        <div className="file-type-help">
          <SelectedIcon size={15} />
          <span className="file-type-badge">{selectedMeta.code}</span>
          {selectedMeta.description}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!title.trim() || saving}>
            {saving ? 'Creating...' : 'Create file'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
