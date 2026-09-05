'use client'

import { useState } from 'react'
import { LogOut, Mail } from 'lucide-react'
import { useAuth } from '../../lib/auth'

export default function AccountPage() {
  const { user, loading, signIn, signUp, signOut } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return null

  if (user) {
    return (
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">Account</h1>
        </div>
        <section className="settings-section">
          <h2>Signed in</h2>
          <p className="settings-blurb">
            <Mail size={14} /> {user.email}
          </p>
          <p className="settings-blurb">
            Your projects, chats, and engine preferences sync to this account.
          </p>
          <div className="settings-row">
            <button className="btn-quiet" onClick={() => signOut()}>
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        </section>
      </div>
    )
  }

  async function submit() {
    setError(null)
    setInfo(null)
    setBusy(true)
    const result = mode === 'signup' ? await signUp(email, password) : await signIn(email, password)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    if (mode === 'signup') setInfo('Check your email to confirm your account, then sign in.')
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Account</h1>
      </div>
      <section className="settings-section">
        <h2>{mode === 'signin' ? 'Sign in' : 'Create an account'}</h2>
        <p className="settings-blurb">
          Optional — everything already works without an account, saved to this browser
          only. Signing in syncs your projects and chats to the cloud and moves this
          browser&apos;s existing work there the first time you sign in.
        </p>
        <div className="settings-row">
          <input
            type="email"
            className="settings-input"
            value={email}
            placeholder="you@example.com"
            autoComplete="email"
            onChange={e => setEmail(e.target.value)}
            aria-label="Email"
          />
        </div>
        <div className="settings-row">
          <input
            type="password"
            className="settings-input"
            value={password}
            placeholder="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            onChange={e => setPassword(e.target.value)}
            aria-label="Password"
          />
        </div>
        <div className="settings-row">
          <button className="btn-quiet" disabled={busy || !email || !password} onClick={submit}>
            {mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
          <button
            className="btn-quiet"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}
          >
            {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
          </button>
        </div>
        {error && <div className="settings-note"><p>{error}</p></div>}
        {info && <div className="settings-note"><p>{info}</p></div>}
      </section>
    </div>
  )
}
