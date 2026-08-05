'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Plus, Search, Trash2, X } from 'lucide-react'
import type { Project } from '../../lib/sessions'
import { shortDate } from './format'

type Sort = 'updated' | 'created' | 'name'

const SORT_LABELS: Record<Sort, string> = {
  updated: 'Last updated',
  created: 'Date created',
  name: 'Name',
}

export default function ProjectsPage({
  projects,
  countFor,
  onOpen,
  onCreate,
  onDelete,
}: {
  projects: Project[]
  countFor: (projectId: string) => number
  onOpen: (project: Project) => void
  onCreate: (name: string, description: string) => void
  onDelete: (project: Project) => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [sort, setSort] = useState<Sort>('updated')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (searching) searchRef.current?.focus() }, [searching])
  useEffect(() => { if (creating) nameRef.current?.focus() }, [creating])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? projects.filter(p => `${p.name} ${p.description ?? ''}`.toLowerCase().includes(needle))
      : projects
    const sorted = [...matches]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'created') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    else sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return sorted
  }, [projects, query, sort])

  function submitNew() {
    if (!name.trim()) return
    onCreate(name, description)
    setName('')
    setDescription('')
    setCreating(false)
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Projects</h1>
        <div className="page-actions">
          {searching ? (
            <label className="page-search">
              <Search size={15} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search projects"
                aria-label="Search projects"
                onChange={event => setQuery(event.target.value)}
                onBlur={() => { if (!query.trim()) setSearching(false) }}
                onKeyDown={event => {
                  if (event.key === 'Escape') { setQuery(''); setSearching(false) }
                }}
              />
            </label>
          ) : (
            <button className="icon-button" aria-label="Search projects" onClick={() => setSearching(true)}>
              <Search size={16} />
            </button>
          )}
          <label className="sort-select">
            Sort by <strong>{SORT_LABELS[sort]}</strong>
            <select
              aria-label="Sort projects"
              value={sort}
              onChange={event => setSort(event.target.value as Sort)}
            >
              {(Object.keys(SORT_LABELS) as Sort[]).map(key => (
                <option key={key} value={key}>{SORT_LABELS[key]}</option>
              ))}
            </select>
          </label>
          <button className="btn-dark" onClick={() => setCreating(true)}>
            New project
          </button>
        </div>
      </div>

      {!visible.length && (
        <div className="page-empty">
          <Archive size={22} />
          <strong>{projects.length ? 'No projects match that search' : 'No projects yet'}</strong>
          <p>
            A project keeps related work together — a problem set, a lab, an exam topic.
            Chats you start inside one stay filed there.
          </p>
          {!projects.length && (
            <button className="btn-dark" onClick={() => setCreating(true)}>
              <Plus size={15} />
              New project
            </button>
          )}
        </div>
      )}

      <div className="proj-grid">
        {visible.map(project => {
          const count = countFor(project.id)
          return (
            <article
              key={project.id}
              className="proj-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(project)}
              onKeyDown={event => { if (event.key === 'Enter') onOpen(project) }}
            >
              <h3 className="proj-card-title">{project.name}</h3>
              <p className={`proj-card-desc${project.description?.trim() ? '' : ' muted'}`}>
                {project.description?.trim() || 'No description yet.'}
              </p>
              <div className="proj-card-foot">
                <span>
                  {count ? `${count} ${count === 1 ? 'chat' : 'chats'} · ` : ''}
                  {shortDate(project.updatedAt)}
                </span>
                <button
                  className="row-delete"
                  aria-label={`Delete project ${project.name}`}
                  onClick={event => { event.stopPropagation(); onDelete(project) }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          )
        })}
      </div>

      {creating && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onClick={event => { if (event.target === event.currentTarget) setCreating(false) }}
        >
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Create project">
            <div className="sheet-head">
              <h2>New project</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setCreating(false)}>
                <X size={16} />
              </button>
            </div>
            <label className="field">
              <span>Name</span>
              <input
                ref={nameRef}
                type="text"
                value={name}
                placeholder="Aldol problem set"
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') submitNew() }}
              />
            </label>
            <label className="field">
              <span>What&rsquo;s this project about? <em>(optional)</em></span>
              <textarea
                rows={3}
                value={description}
                placeholder="Context the assistant should keep in mind for every chat in this project."
                onChange={event => setDescription(event.target.value)}
              />
            </label>
            <div className="sheet-actions">
              <button className="btn-quiet" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn-dark" onClick={submitNew} disabled={!name.trim()}>
                Create project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
