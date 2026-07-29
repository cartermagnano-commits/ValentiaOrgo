'use client'

import { Suspense, use } from 'react'
import { useSearchParams } from 'next/navigation'
import ProjectPage from '../../../src/platform/ProjectPage'

function ProjectRouteInner({ projectId }: { projectId: string }) {
  // ?file=<id> deep-links straight into a file (e.g. the dashboard's
  // "New Chat" button) instead of landing on the tool picker.
  const searchParams = useSearchParams()
  return <ProjectPage projectId={projectId} initialFileId={searchParams.get('file')} />
}

export default function ProjectRoute({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params)
  return (
    <Suspense>
      <ProjectRouteInner projectId={projectId} />
    </Suspense>
  )
}
