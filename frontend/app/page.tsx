import Workspace from '../src/platform/Workspace'
import { AuthProvider } from '../lib/auth'

export default function HomePage() {
  return (
    <AuthProvider>
      <Workspace />
    </AuthProvider>
  )
}
