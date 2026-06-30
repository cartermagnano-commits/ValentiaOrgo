import ProjectPage from '../../../src/platform/ProjectPage'

type ProjectRouteProps = {
  params: Promise<{ projectId: string }>
}

export default async function ProjectRoute({ params }: ProjectRouteProps) {
  const { projectId } = await params

  return <ProjectPage projectId={projectId} />
}
