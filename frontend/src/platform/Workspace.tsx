'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Beaker, FlaskConical, MessageSquare, Network, Trash2 } from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import DirectReact from '../components/DirectReact'
import ChatPanel from './ChatPanel'
import type { ChatContent, SessionContent, Tool } from '../types'
import {
  Session,
  createSession,
  deleteSession,
  hasRealContent,
  loadSessions,
  saveSession,
} from '../../lib/sessions'

const TOOLS: Array<{ tool: Tool; label: string; icon: typeof Network; blurb: string }> = [
  { tool: 'synthesis', label: 'Synthesis', icon: Network, blurb: 'Explore reagent routes from a starting molecule' },
  { tool: 'direct_reaction', label: 'Reaction', icon: FlaskConical, blurb: 'Substrate + reagent → predicted products' },
  { tool: 'chat', label: 'Chat', icon: MessageSquare, blurb: 'Ask anything, attach images or files' },
]

function toolMeta(tool: Tool) {
  return TOOLS.find(t => t.tool === tool) ?? TOOLS[0]
}

// Sidebar grouping: Today / Yesterday / "Jul 28"
function dayLabel(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function Workspace() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [active, setActive] = useState<Session | null>(null)
  const [hydrated, setHydrated] = useState(false)

  // localStorage isn't available during SSR — load once on mount, then start
  // a fresh chat session so the app opens ready to use.
  useEffect(() => {
    const stored = loadSessions()
    setSessions(stored)
    setActive(createSession('chat'))
    setHydrated(true)
  }, [])

  // Autosave: any content change on a session with real work persists it and
  // refreshes its sidebar row. Empty sessions are never written.
  const activeRef = useRef(active)
  activeRef.current = active

  function persistIfReal(session: Session) {
    if (!hasRealContent(session)) return session
    const saved = saveSession(session)
    setSessions(prev => [saved, ...prev.filter(s => s.id !== saved.id)])
    return saved
  }

  // Debounced persist: chat streaming calls updateContent per token, and
  // serializing every session to localStorage on each delta would jank the UI.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateContent(content: SessionContent) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content }
    setActive(next)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const latest = activeRef.current
      if (latest && latest.id === next.id) persistIfReal(latest)
    }, 400)
  }

  useEffect(() => () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      const latest = activeRef.current
      if (latest && hasRealContent(latest)) saveSession(latest)
    }
  }, [])

  // Tool-save callbacks (PathwayExplorer/DirectReact call onSave with partial
  // data on explicit saves; merge over the current content).
  function mergeAndSave(data: Record<string, unknown>) {
    const current = activeRef.current
    if (!current) return
    const next = { ...current, content: { ...(current.content as Record<string, unknown>), ...data } as SessionContent }
    setActive(persistIfReal(next))
  }

  function startTool(tool: Tool) {
    setActive(createSession(tool))
  }

  function openSession(session: Session) {
    setActive(session)
  }

  function removeSession(session: Session) {
    if (!window.confirm(`Delete "${session.title || 'this session'}"?`)) return
    deleteSession(session.id)
    setSessions(prev => prev.filter(s => s.id !== session.id))
    if (active?.id === session.id) setActive(createSession(session.tool))
  }

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: Session[] }> = []
    for (const session of sessions) {
      const label = dayLabel(session.updatedAt)
      const group = groups.find(g => g.label === label)
      if (group) group.items.push(session)
      else groups.push({ label, items: [session] })
    }
    return groups
  }, [sessions])

  if (!hydrated || !active) return null

  const activeMeta = toolMeta(active.tool)
  const content = active.content as Record<string, unknown>

  return (
    <div className="workspace-app">
      <header className="workspace-topbar">
        <div className="workspace-brand">
          <div className="brand-mark"><Beaker size={18} /></div>
          <h1>Orgo AI</h1>
        </div>
        <nav className="workspace-tabs" aria-label="Tools">
          {TOOLS.map(({ tool, label, icon: Icon, blurb }) => (
            <button
              key={tool}
              className={`workspace-tab${active.tool === tool ? ' active' : ''}`}
              title={blurb}
              onClick={() => startTool(tool)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="workspace-columns">
        <aside className="history-sidebar">
          <div className="history-heading">History</div>
          {!sessions.length && (
            <div className="history-empty">
              Your work saves here automatically — no accounts, no files to manage.
            </div>
          )}
          {grouped.map(group => (
            <div key={group.label} className="history-group">
              <div className="history-day">{group.label}</div>
              {group.items.map(session => {
                const meta = toolMeta(session.tool)
                const Icon = meta.icon
                return (
                  <div
                    key={session.id}
                    className={`history-item${active.id === session.id ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openSession(session)}
                    onKeyDown={event => { if (event.key === 'Enter') openSession(session) }}
                  >
                    <Icon size={14} />
                    <span className="history-title">{session.title || meta.label}</span>
                    <button
                      className="history-delete"
                      aria-label={`Delete ${session.title || meta.label}`}
                      onClick={event => {
                        event.stopPropagation()
                        removeSession(session)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </aside>

        <main className={`workspace-main${active.tool === 'chat' ? ' chat-main' : ''}`}>
          {active.tool === 'synthesis' && (
            <PathwayExplorer
              key={active.id}
              initialSubstrate={Array.isArray(content.startingMaterials)
                ? (content.startingMaterials as string[]).filter(Boolean)
                : []}
              initialTarget={(content.targetMolecule as string) ?? ''}
              initialPathways={content.pathwaysData ?? null}
              onSave={(data: Record<string, unknown>) => mergeAndSave(data)}
            />
          )}
          {active.tool === 'direct_reaction' && (
            <DirectReact
              key={active.id}
              initialSubstrate={(content.reactants as string[])?.[0] ?? ''}
              initialReagent={(content.reagents as string) ?? ''}
              initialResult={content.result ?? null}
              onSave={(data: Record<string, unknown>) => mergeAndSave(data)}
            />
          )}
          {active.tool === 'chat' && (
            <ChatPanel
              key={active.id}
              content={active.content as ChatContent}
              onChange={next => updateContent(next)}
              onSave={async next => { if (next) updateContent(next) }}
              saving={false}
            />
          )}
        </main>
      </div>
    </div>
  )
}
