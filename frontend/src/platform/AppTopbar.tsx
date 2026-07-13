'use client'

import Link from 'next/link'
import { LogOut, SlidersHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabaseClient'
import { Beaker } from './fileTypes'

export default function AppTopbar({
  email,
  compact = false,
}: {
  email?: string | null
  compact?: boolean
}) {
  const router = useRouter()

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <header className="platform-topbar">
      <Link href="/dashboard" className="topbar-home" aria-label="Go to your dashboard">
        <div className="brand-mark">
          <Beaker size={18} />
        </div>
        <div>
          <h1>Orgo AI</h1>
          <div className="subtitle">{compact ? 'Organic chemistry AI workspace' : 'Project-based organic chemistry workspace'}</div>
        </div>
      </Link>
      {email && (
        <div className="topbar-actions">
          <span className="user-email">{email}</span>
          <button className="btn-secondary action-button" onClick={() => router.push('/settings')}>
            <SlidersHorizontal size={15} />
            Engine
          </button>
          <button className="btn-secondary action-button" onClick={logout}>
            <LogOut size={15} />
            Logout
          </button>
        </div>
      )}
    </header>
  )
}
