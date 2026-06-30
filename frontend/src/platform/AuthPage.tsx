'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, Beaker, Lock, Mail } from 'lucide-react'
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient'

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
      } else {
        router.replace('/dashboard')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.')
    } finally {
      setLoading(false)
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
