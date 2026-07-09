'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, Beaker, Lock, Mail } from 'lucide-react'
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient'

const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)

export default function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/dashboard')
    })
  }, [router])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      const result = mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

      if (result.error) throw result.error

      if (mode === 'signup' && !result.data.session) {
        setMessage('Account created. Check your email to confirm your address, then log in.')
      } else if (mode === 'signup') {
        // Brand-new account → straight to engine onboarding before the dashboard.
        router.replace('/settings?onboarding=1')
      } else {
        router.replace('/dashboard')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  async function signInWithGoogle() {
    setError('')
    setMessage('')
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/dashboard` },
      })
      if (error) throw error
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed. Is the provider enabled in Supabase?')
    }
  }

  async function handleForgotPassword() {
    setError('')
    setMessage('')
    if (!email) {
      setError('Enter your email above first, then click “Forgot password?”.')
      return
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset`,
      })
      if (error) throw error
      setMessage('Password reset email sent. Check your inbox for the link.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset email.')
    }
  }

  const isLogin = mode === 'login'

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <Beaker size={18} />
          </span>
          <div>
            <h1>Orgo AI</h1>
            <p>Secure chemistry workspaces for projects and files.</p>
          </div>
        </div>

        <div className="auth-heading">
          <h2>{isLogin ? 'Log in' : 'Create account'}</h2>
          <p>{isLogin ? 'Continue to your saved chemistry projects.' : 'Start saving synthesis plans, reactions, and notes.'}</p>
        </div>

        {!isSupabaseConfigured && (
          <div className="error-banner">
            Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to `frontend/.env.local`.
          </div>
        )}

        <button
          type="button"
          className="oauth-button"
          onClick={signInWithGoogle}
          disabled={!isSupabaseConfigured}
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <div className="auth-divider"><span>or</span></div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>Email</span>
            <div className="input-with-icon">
              <Mail size={15} />
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="input-with-icon">
              <Lock size={15} />
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="At least 6 characters"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                required
                minLength={6}
              />
            </div>
          </label>

          {isLogin && (
            <button type="button" className="auth-link-button" onClick={handleForgotPassword}>
              Forgot password?
            </button>
          )}

          {error && <div className="error-banner">{error}</div>}
          {message && <div className="success-banner">{message}</div>}

          <button className="btn-primary action-button auth-submit" disabled={loading || !isSupabaseConfigured}>
            {loading ? 'Working...' : isLogin ? 'Log in' : 'Sign up'}
            <ArrowRight size={15} />
          </button>
        </form>

        <p className="auth-switch">
          {isLogin ? 'Need an account?' : 'Already have an account?'}{' '}
          <Link href={isLogin ? '/signup' : '/login'}>{isLogin ? 'Sign up' : 'Log in'}</Link>
        </p>
      </section>
    </main>
  )
}
