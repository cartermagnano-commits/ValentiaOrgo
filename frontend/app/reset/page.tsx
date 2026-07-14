'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Beaker, Lock } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      // Supabase establishes a recovery session from the emailed link; updateUser
      // then sets the new password.
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setMessage('Password updated. Redirecting to your dashboard…')
      setTimeout(() => router.replace('/dashboard'), 1400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update password. Open the reset link from your email again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark"><Beaker size={18} /></span>
          <div>
            <h1>Orgo AI</h1>
            <p>Set a new password.</p>
          </div>
        </div>

        <div className="auth-heading">
          <h2>Reset password</h2>
          <p>Enter a new password for your account.</p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>New password</span>
            <div className="input-with-icon">
              <Lock size={15} />
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="At least 6 characters"
                autoComplete="new-password"
                required
                minLength={6}
              />
            </div>
          </label>

          {error && <div className="error-banner">{error}</div>}
          {message && <div className="success-banner">{message}</div>}

          <button className="btn-primary action-button auth-submit" disabled={loading}>
            {loading ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </section>
    </main>
  )
}
