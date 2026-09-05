'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session as SupabaseSession, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { localSessionStore } from './localSessionStore'
import { makeCloudSessionStore } from './cloudSessionStore'
import { migrateLocalToCloud } from './migrate'
import type { SessionStore } from './sessionStore'

type AuthContextValue = {
  user: User | null
  loading: boolean
  store: SessionStore
  signUp: (email: string, password: string) => Promise<{ error: string | null }>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  // Guards against re-running migration on every token refresh
  // (onAuthStateChange fires for those too, not just sign-in).
  const migratingFor = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session: SupabaseSession | null) => {
      setUser(session?.user ?? null)
      if (session?.user && migratingFor.current !== session.user.id) {
        migratingFor.current = session.user.id
        migrateLocalToCloud(makeCloudSessionStore(session.user.id))
      }
      if (!session?.user) migratingFor.current = null
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const store: SessionStore = user ? makeCloudSessionStore(user.id) : localSessionStore

  async function signUp(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password })
    return { error: error?.message ?? null }
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, loading, store, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
