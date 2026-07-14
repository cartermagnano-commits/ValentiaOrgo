'use client'

import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react'

// Route-level error boundary for the project workspace. A saved file whose
// jsonb content has an unexpected shape can throw during render; without this
// boundary that whitescreens the page with no way to open a different file or
// delete the bad one.
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  return (
    <main className="dashboard-page">
      <div className="error-state" style={{ marginTop: 60 }}>
        <AlertTriangle size={34} />
        <h2>Something went wrong in this project</h2>
        <p>
          A saved file could not be displayed{error?.message ? ` (${error.message})` : ''}.
          Try again, or go back to your projects.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 12 }}>
          <button className="btn-secondary action-button" onClick={() => reset()}>
            <RotateCcw size={15} />
            Try again
          </button>
          <button className="btn-primary action-button" onClick={() => router.push('/dashboard')}>
            <ArrowLeft size={15} />
            Back to projects
          </button>
        </div>
      </div>
    </main>
  )
}
