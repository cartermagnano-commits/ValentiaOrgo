'use client'

import ProjectPage from '../../../src/platform/ProjectPage'

export default function ProjectRoute({ params }: { params: { projectId: string } }) {
  return <ProjectPage projectId={params.projectId} />
}
