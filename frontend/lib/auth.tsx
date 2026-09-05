'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session as SupabaseSession, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { localSessionStore } from './localSessionStore'
import { makeCloudSessionStore } from './cloudSessionStore'
import { migrateLocalToCloud } from './migrate'
import { loadCloudModel, saveCloudModel } from './cloudSettings'
import { loadPreferredModel, savePreferredModel } from './engine'
import type { SessionStore } from './sessionStore'

type AuthContextValue = {
  user: User | null
  loading: boolean
  // True while this browser's local history is being uploaded into a
  // just-signed-in account. Consumers MUST NOT read `store` while it is set:
  // the cloud account is mid-write, so a read now sees a partial history and
  // nothing re-reads it when the upload finishes. Workspace.tsx defers
  // hydration on this flag and re-runs when it clears.
  migrating: boolean
  store: SessionStore
  signUp: (email: string, password: string) => Promise<{ error: string | null }>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Account preference wins on sign-in if one was ever saved; otherwise this
// browser's current local pick becomes the account's first saved preference.
async function syncModelPreferenceOnSignIn(userId: string): Promise<void> {
  try {
    const cloudModel = await loadCloudModel(userId)
    if (cloudModel) {
      savePreferredModel(cloudModel)
    } else {
      await saveCloudModel(userId, loadPreferredModel())
    }
  } catch (err) {
    console.error('Engine-preference sync failed', err)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [migrating, setMigrating] = useState(false)
  // Guards against re-running migration on every token refresh
  // (onAuthStateChange fires for those too, not just sign-in).
  const migratingFor = useRef<string | null>(null)

  useEffect(() => {
    // `loading` gates Workspace.tsx's hydration, so it MUST resolve even when
    // Supabase is unreachable or configured with placeholder credentials —
    // otherwise the workspace would never render at all. Hence catch+finally.
    supabase.auth.getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch(err => console.error('Supabase getSession failed', err))
      .finally(() => setLoading(false))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session: SupabaseSession | null) => {
      setUser(session?.user ?? null)
      if (session?.user && migratingFor.current !== session.user.id) {
        const userId = session.user.id
        migratingFor.current = userId
        // Flagged, not awaited: setUser above has already flipped `store` to
        // the cloud implementation, so anything that reads it before this
        // finishes would see a half-uploaded account. migrateLocalToCloud
        // swallows its own errors, so `finally` always clears the flag.
        setMigrating(true)
        migrateLocalToCloud(makeCloudSessionStore(userId), userId)
          .finally(() => setMigrating(false))
        syncModelPreferenceOnSignIn(userId)
      }
      if (!session?.user) {
        migratingFor.current = null
        setMigrating(false)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Memoized on the user id, not the User object: Supabase re-emits SIGNED_IN
  // with a freshly-parsed `session.user` on every tab-focus/token refresh, and
  // an unmemoized store would hand consumers a new identity each time —
  // re-triggering Workspace.tsx's hydration effect and letting a stale DB read
  // clobber unsaved in-memory work.
  const store: SessionStore = useMemo(
    () => (user ? makeCloudSessionStore(user.id) : localSessionStore),
    [user?.id],
  )

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
    <AuthContext.Provider value={{ user, loading, migrating, store, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
