'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, LayoutGrid, LogOut, NotebookText, Plus, Trash2 } from 'lucide-react'
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
import Reveal from './Reveal'
import Splash from './Splash'
import { statusText } from './format'

// The three workhorse tools get hero cards with richer copy; the rest render
// as compact cards below. Copy lives here, everything else in FILE_TYPES.
const FEATURED_BLURBS: Partial<Record<ChemistryFileType, string>> = {
  synthesis: 'Enter a starting molecule and explore all reagent routes to products.',
  direct_reaction: 'Give a substrate and reagent — get predicted products with mechanisms.',
  predict_reaction: 'Upload a whiteboard photo or drawing and predict the reaction products.',
}

export default function ProjectPage({ projectId, initialFileId }: { projectId: string; initialFileId?: string | null }) {
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
        // Land on the tool picker (not an auto-opened file) so the project's
        // capabilities are the first thing a user sees — unless the URL
        // deep-links a specific file (dashboard "New Chat").
        if (initialFileId && fileResult.some(file => file.id === initialFileId)) {
          setActiveFileId(initialFileId)
        }
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
  }, [projectId, initialFileId, router])

  const activeFile = files.find(file => file.id === activeFileId) ?? null

  async function handleCreateFile(payload: { title: string; type: ChemistryFileType }, fromModal = true) {
    if (!user || !project) return
    const file = await createChemistryFile(project.id, user.id, payload.title, payload.type)
    setFiles(prev => [file, ...prev])
    setActiveFileId(file.id)
    if (fromModal) setModalOpen(false)
  }

  function startTool(type: ChemistryFileType) {
    handleCreateFile({ title: fileTypeMeta(type).defaultTitle, type }, false).catch(err => {
      setError(err instanceof Error ? err.message : 'Could not create file.')
    })
  }

  async function handleDeleteFile(file: ChemistryFile) {
    if (!user || !project) return
    const ok = window.confirm(`Delete "${file.title}"?`)
    if (!ok) return
    try {
      await deleteChemistryFile(file.id, project.id, user.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete file.')
      return
    }
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
        <Splash message="Loading project…" />
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
              <div
                className={`file-list-item tools-home${!activeFile ? ' active' : ''}`}
                onClick={() => setActiveFileId(null)}
                role="button"
                tabIndex={0}
                onKeyDown={event => {
                  if (event.key === 'Enter') setActiveFileId(null)
                }}
              >
                <LayoutGrid size={15} />
                <span>
                  <strong>All tools</strong>
                  <small>Start a new operation</small>
                </span>
              </div>

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
                const content = file.content as Record<string, unknown> | null
                const hasAiRun = Boolean(content?.aiResponse || content?.pathwaysData || content?.result)
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
                      <small>{statusText(file.updated_at)} · {hasAiRun ? 'AI response saved' : 'AI not run yet'}</small>
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
              <>
                <div className="tool-strip" role="toolbar" aria-label="Start a new tool">
                  <span className="tool-strip-label">New</span>
                  {FILE_TYPES.map(tool => {
                    const Icon = tool.icon
                    return (
                      <button key={tool.type} className="tool-chip" title={tool.description} onClick={() => startTool(tool.type)}>
                        <Icon size={14} />
                        {tool.label}
                      </button>
                    )
                  })}
                </div>
                <FileEditor
                  // Keyed by file id so switching files unmounts the editor.
                  // Without this, an in-flight AI stream started on file A keeps
                  // writing into the shared draft after the user opens file B,
                  // and its completion handler saves B's draft into A's row.
                  key={activeFile.id}
                  file={activeFile}
                  files={files}
                  userId={user.id}
                  onSaved={handleSavedFile}
                />
              </>
            ) : (
              <ToolPickerState onStart={startTool} />
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

function ToolPickerState({ onStart }: { onStart: (type: ChemistryFileType) => void }) {
  const featured = FILE_TYPES.filter(tool => tool.type in FEATURED_BLURBS)
  const secondary = FILE_TYPES.filter(tool => !(tool.type in FEATURED_BLURBS))

  return (
    <div className="tool-picker">
      <Reveal>
      <div className="tool-picker-heading">
        <div className="eyebrow">Project tools</div>
        <h3>What do you want to work on?</h3>
        <p>Every tool saves as a file in this project, so your work is always preserved.</p>
      </div>
      </Reveal>

      <div className="tool-picker-primary">
        {featured.map((tool, index) => {
          const Icon = tool.icon
          return (
            <Reveal key={tool.type} delay={80 + index * 70}>
            <button className="tool-picker-card primary" onClick={() => onStart(tool.type)}>
              <div className="tool-picker-card-icon"><Icon size={24} /></div>
              <div>
                <strong>{tool.defaultTitle}</strong>
                <span>{FEATURED_BLURBS[tool.type]}</span>
              </div>
            </button>
            </Reveal>
          )
        })}
      </div>

      <div className="tool-picker-divider">
        <span>More tools</span>
      </div>

      <div className="tool-picker-secondary">
        {secondary.map((tool, index) => {
          const Icon = tool.icon
          return (
            <Reveal key={tool.type} delay={320 + index * 50}>
            <button className="tool-picker-card secondary" title={tool.description} onClick={() => onStart(tool.type)}>
              <Icon size={16} />
              <div>
                <strong>{tool.defaultTitle}</strong>
                <span>{tool.description}</span>
              </div>
            </button>
            </Reveal>
          )
        })}
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
