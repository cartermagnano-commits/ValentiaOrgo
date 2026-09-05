'use client'

import { useState } from 'react'
import { LogOut, Mail } from 'lucide-react'
import { useAuth } from '../../lib/auth'

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  )
}

export default function AccountPage() {
  const { user, loading, signIn, signUp, signInWithGoogle, signOut } = useAuth()
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

  async function google() {
    setError(null)
    setInfo(null)
    setBusy(true)
    // On success the browser is already navigating away to Google, so there is
    // nothing more to do; only a failure to start the redirect lands here.
    const result = await signInWithGoogle()
    if (result.error) {
      setBusy(false)
      setError(result.error)
    }
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
        <button className="oauth-button" disabled={busy} onClick={google}>
          <GoogleIcon />
          Continue with Google
        </button>
        <div className="auth-divider"><span>or</span></div>
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
