'use client'

import { use } from 'react'
import ProjectPage from '../../../src/platform/ProjectPage'

export default function ProjectRoute({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params)
  return <ProjectPage projectId={projectId} />
}
