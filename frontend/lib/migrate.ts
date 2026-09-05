// One-time upload of this BROWSER's local projects/sessions into a
// newly-signed-in account. Local data is left in place, untouched — this
// only stops being read from once migration completes.
//
// Known limitation (accepted — see the design spec): the migrated flag is
// per-browser, not per-account, so only the FIRST account that ever signs in
// on a given browser gets that browser's local history. A different account
// signing in later on the same browser will not be re-offered it.
import { localSessionStore } from './localSessionStore'
import type { SessionStore } from './sessionStore'

const MIGRATED_KEY = 'orgo.migrated.v1'

export function hasMigrated(): boolean {
  try {
    return window.localStorage.getItem(MIGRATED_KEY) === 'true'
  } catch {
    return true  // storage unavailable — nothing we can do, don't retry forever
  }
}

function markMigrated(): void {
  try { window.localStorage.setItem(MIGRATED_KEY, 'true') } catch { /* best effort */ }
}

export async function migrateLocalToCloud(cloud: SessionStore): Promise<void> {
  if (hasMigrated()) return
  try {
    const [localProjects, localSessions] = await Promise.all([
      localSessionStore.loadProjects(),
      localSessionStore.loadSessions(),
    ])
    // Projects first — sessions reference them by id, and the cloud store
    // mints new project ids on insert, so references must be remapped.
    const idMap = new Map<string, string>()
    for (const project of localProjects) {
      const created = await cloud.createProject(project.name, project.description)
      idMap.set(project.id, created.id)
    }
    for (const session of localSessions) {
      await cloud.saveSession({
        ...session,
        projectId: session.projectId ? (idMap.get(session.projectId) ?? null) : null,
      })
    }
    markMigrated()
  } catch (err) {
    // Best-effort: a failed migration must not block sign-in. The flag is
    // deliberately NOT set here, so the next sign-in retries.
    console.error('Local-to-cloud migration failed', err)
  }
}
