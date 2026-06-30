'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FlaskConical, GitBranch, LogOut, MessageSquare, Microscope, Network, NotebookText, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
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

  async function handleCreateFile(payload: { title: string; type: ChemistryFileType }, fromModal = true) {
    if (!user || !project) return
    const file = await createChemistryFile(project.id, user.id, payload.title, payload.type)
    setFiles(prev => [file, ...prev])
    setActiveFileId(file.id)
    if (fromModal) setModalOpen(false)
  }

  function startTool(type: ChemistryFileType, defaultTitle: string) {
    handleCreateFile({ title: defaultTitle, type }, false)
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
              <ToolPickerState onStart={startTool} onNewFile={() => setModalOpen(true)} />
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

function ToolPickerState({
  onStart,
  onNewFile,
}: {
  onStart: (type: ChemistryFileType, defaultTitle: string) => void
  onNewFile: () => void
}) {
  return (
    <div className="tool-picker">
      <div className="tool-picker-heading">
        <h3>Choose a chemistry tool</h3>
        <p>Each tool is saved as a file inside this project so your work is always preserved.</p>
      </div>

      <div className="tool-picker-primary">
        <button className="tool-picker-card primary" onClick={() => onStart('synthesis', 'Synthesis Pathway')}>
          <div className="tool-picker-card-icon"><Network size={26} /></div>
          <div>
            <strong>Synthesis Pathways</strong>
            <span>Enter a starting molecule and explore all reagent routes to products.</span>
          </div>
        </button>
        <button className="tool-picker-card primary" onClick={() => onStart('direct_reaction', 'Direct Reaction')}>
          <div className="tool-picker-card-icon"><FlaskConical size={26} /></div>
          <div>
            <strong>Direct Reaction</strong>
            <span>Give a substrate and reagent — get predicted products with mechanisms.</span>
          </div>
        </button>
        <button className="tool-picker-card primary" onClick={() => onStart('predict_reaction', 'Reaction Prediction')}>
          <div className="tool-picker-card-icon"><Sparkles size={26} /></div>
          <div>
            <strong>Predict from Image</strong>
            <span>Upload a whiteboard photo or drawing and predict the reaction products.</span>
          </div>
        </button>
      </div>

      <div className="tool-picker-divider">
        <span>More tools</span>
      </div>

      <div className="tool-picker-secondary">
        <button className="tool-picker-card secondary" onClick={() => onStart('mechanism', 'Mechanism')}>
          <GitBranch size={16} /> Mechanism
        </button>
        <button className="tool-picker-card secondary" onClick={() => onStart('retrosynthesis', 'Retrosynthesis')}>
          <Search size={16} /> Retrosynthesis
        </button>
        <button className="tool-picker-card secondary" onClick={() => onStart('molecule_note', 'Molecule Note')}>
          <Microscope size={16} /> Molecule Note
        </button>
        <button className="tool-picker-card secondary" onClick={() => onStart('chat', 'Project Notes')}>
          <MessageSquare size={16} /> Notes / Chat
        </button>
      </div>
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
