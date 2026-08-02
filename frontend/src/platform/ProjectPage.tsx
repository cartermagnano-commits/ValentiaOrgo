'use client'

import { useState } from 'react'
import { ArrowLeft, Check, FlaskConical, MessageSquare, Network, Pencil, Trash2 } from 'lucide-react'
import type { Project, Session } from '../../lib/sessions'
import type { Tool } from '../types'
import { shortDate } from './format'

// One project's page: what it's about, and every chat filed under it.
export default function ProjectPage({
  project,
  sessions,
  toolMeta,
  onBack,
  onOpen,
  onDeleteSession,
  onNew,
  onEdit,
}: {
  project: Project
  sessions: Session[]
  toolMeta: (tool: Tool) => { label: string; icon: React.ComponentType<{ size?: number }> }
  onBack: () => void
  onOpen: (session: Session) => void
  onDeleteSession: (session: Session) => void
  onNew: (tool: Tool) => void
  onEdit: (patch: { name?: string; description?: string }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')

  function save() {
    if (name.trim()) onEdit({ name, description })
    setEditing(false)
  }

  return (
    <div className="page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        Projects
      </button>

      {editing ? (
        <div className="project-edit">
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') save() }}
            />
          </label>
          <label className="field">
            <span>What&rsquo;s this project about?</span>
            <textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} />
          </label>
          <div className="sheet-actions">
            <button className="btn-quiet" onClick={() => { setEditing(false); setName(project.name); setDescription(project.description ?? '') }}>
              Cancel
            </button>
            <button className="btn-dark" onClick={save} disabled={!name.trim()}>
              <Check size={15} />
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="page-head">
          <div>
            <h1 className="page-title">{project.name}</h1>
            {project.description?.trim() && <p className="page-sub">{project.description}</p>}
          </div>
          <div className="page-actions">
            <button className="icon-button" aria-label="Edit project" onClick={() => setEditing(true)}>
              <Pencil size={15} />
            </button>
          </div>
        </div>
      )}

      <div className="project-start-row">
        <button className="start-card" onClick={() => onNew('chat')}>
          <MessageSquare size={16} />
          <strong>New chat</strong>
          <span>Ask anything, filed here</span>
        </button>
        <button className="start-card" onClick={() => onNew('direct_reaction')}>
          <FlaskConical size={16} />
          <strong>New reaction</strong>
          <span>Predict products from molecules or a photo</span>
        </button>
        <button className="start-card" onClick={() => onNew('synthesis')}>
          <Network size={16} />
          <strong>New synthesis</strong>
          <span>Explore reagent routes to a target</span>
        </button>
      </div>

      <h2 className="chat-list-day">
        {sessions.length} {sessions.length === 1 ? 'chat' : 'chats'} in this project
      </h2>
      {!sessions.length ? (
        <div className="page-empty compact">
          <p>Nothing filed here yet — start a chat above and it lands in this project.</p>
        </div>
      ) : (
        <div className="chat-list">
          {sessions.map(session => {
            const meta = toolMeta(session.tool)
            const Icon = meta.icon
            return (
              <div
                key={session.id}
                className="chat-row"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(session)}
                onKeyDown={event => { if (event.key === 'Enter') onOpen(session) }}
              >
                <span className="chat-row-icon"><Icon size={15} /></span>
                <span className="chat-row-title">{session.title || meta.label}</span>
                <span className="chat-row-tool">{meta.label}</span>
                <span className="chat-row-date">{shortDate(session.updatedAt)}</span>
                <button
                  className="row-delete"
                  aria-label={`Delete ${session.title || meta.label}`}
                  onClick={event => { event.stopPropagation(); onDeleteSession(session) }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
