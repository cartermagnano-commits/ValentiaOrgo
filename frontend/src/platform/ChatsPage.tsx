'use client'

import { useMemo, useState } from 'react'
import { MessagesSquare, Plus, Search, Trash2 } from 'lucide-react'
import type { Session } from '../../lib/sessions'
import type { Tool } from '../types'
import { dayLabel, shortDate } from './format'

// Everything that isn't filed under a project: loose chats, one-off reactions,
// quick syntheses. Project work lives on the project's own page.
export default function ChatsPage({
  sessions,
  toolMeta,
  onOpen,
  onDelete,
  onNewChat,
}: {
  sessions: Session[]
  toolMeta: (tool: Tool) => { label: string; icon: React.ComponentType<{ size?: number }> }
  onOpen: (session: Session) => void
  onDelete: (session: Session) => void
  onNewChat: () => void
}) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? sessions.filter(s => (s.title || toolMeta(s.tool).label).toLowerCase().includes(needle))
      : sessions
    const out: Array<{ label: string; items: Session[] }> = []
    for (const session of matches) {
      const label = dayLabel(session.updatedAt)
      const group = out.find(g => g.label === label)
      if (group) group.items.push(session)
      else out.push({ label, items: [session] })
    }
    return out
  }, [sessions, query, toolMeta])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Chats</h1>
        <div className="page-actions">
          <label className="page-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder="Search chats"
              aria-label="Search chats"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <button className="btn-dark" onClick={onNewChat}>
            <Plus size={15} />
            New chat
          </button>
        </div>
      </div>

      {!groups.length && (
        <div className="page-empty">
          <MessagesSquare size={22} />
          <strong>{sessions.length ? 'No chats match that search' : 'Nothing here yet'}</strong>
          <p>
            {sessions.length
              ? 'Try a different word, or start something new.'
              : 'Chats, reactions and syntheses that aren’t filed under a project show up here automatically.'}
          </p>
        </div>
      )}

      {groups.map(group => (
        <section key={group.label} className="chat-list-group">
          <h2 className="chat-list-day">{group.label}</h2>
          <div className="chat-list">
            {group.items.map(session => {
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
                    onClick={event => { event.stopPropagation(); onDelete(session) }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
