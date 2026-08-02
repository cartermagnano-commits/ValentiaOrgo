'use client'

import {
  Archive, Beaker, FlaskConical, MessagesSquare, Network,
  PanelLeft, Plus, Settings,
} from 'lucide-react'
import type { View } from '../../lib/sessions'
import type { Tool } from '../types'

// The always-visible left rail. Icon-only, with a label that slides out on
// hover — the whole shell is one page, so this is the only navigation.
export default function NavRail({
  view,
  tool,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onTool,
  onView,
}: {
  view: View
  tool: Tool
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewChat: () => void
  onTool: (tool: Tool) => void
  onView: (view: View) => void
}) {
  // A tool button lights up only while its own workspace is on screen —
  // browsing Chats or Projects dims the whole tool group.
  const onTools = view === 'tool'

  return (
    <nav className="nav-rail" aria-label="Main">
      <button
        className={`rail-btn${sidebarOpen ? ' toggled' : ''}`}
        data-label={sidebarOpen ? 'Hide recents' : 'Show recents'}
        aria-label={sidebarOpen ? 'Hide recents' : 'Show recents'}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={19} />
      </button>

      <div className="rail-group">
        <button
          className="rail-btn accent"
          data-label="New chat"
          aria-label="New chat"
          onClick={onNewChat}
        >
          <Plus size={19} />
        </button>
        <button
          className={`rail-btn${onTools && tool === 'direct_reaction' ? ' active' : ''}`}
          data-label="Reaction"
          aria-label="Reaction"
          aria-current={onTools && tool === 'direct_reaction' ? 'page' : undefined}
          onClick={() => onTool('direct_reaction')}
        >
          <FlaskConical size={19} />
        </button>
        <button
          className={`rail-btn${onTools && tool === 'synthesis' ? ' active' : ''}`}
          data-label="Synthesis"
          aria-label="Synthesis"
          aria-current={onTools && tool === 'synthesis' ? 'page' : undefined}
          onClick={() => onTool('synthesis')}
        >
          <Network size={19} />
        </button>
        <button
          className={`rail-btn${view === 'chats' ? ' active' : ''}`}
          data-label="Chats"
          aria-label="Chats"
          aria-current={view === 'chats' ? 'page' : undefined}
          onClick={() => onView('chats')}
        >
          <MessagesSquare size={19} />
        </button>
        <button
          className={`rail-btn${view === 'projects' || view === 'project' ? ' active' : ''}`}
          data-label="Projects"
          aria-label="Projects"
          aria-current={view === 'projects' || view === 'project' ? 'page' : undefined}
          onClick={() => onView('projects')}
        >
          <Archive size={19} />
        </button>
        <button
          className={`rail-btn${view === 'settings' ? ' active' : ''}`}
          data-label="Settings"
          aria-label="Settings"
          aria-current={view === 'settings' ? 'page' : undefined}
          onClick={() => onView('settings')}
        >
          <Settings size={19} />
        </button>
      </div>

      <div className="rail-mark" title="Orgo AI" aria-hidden="true">
        <Beaker size={15} />
      </div>
    </nav>
  )
}
