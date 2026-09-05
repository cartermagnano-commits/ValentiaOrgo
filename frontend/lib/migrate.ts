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
// Partial progress from a migration that failed part-way through: local
// project id -> the cloud project id already created for it.
const PARTIAL_KEY = 'orgo.migration.idmap.v1'

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

type PartialIdMap = { userId: string; entries: Array<[string, string]> }

// Scoped to the account it was built against: the migrated flag is per-browser,
// so a DIFFERENT account can be the one retrying, and reusing the first
// account's cloud project ids would file its sessions under projects it can't
// even read (RLS). A mismatch discards the partial map and starts clean.
function loadPartialIdMap(userId: string): Map<string, string> {
  try {
    const raw = window.localStorage.getItem(PARTIAL_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as PartialIdMap
    if (!parsed || parsed.userId !== userId || !Array.isArray(parsed.entries)) return new Map()
    return new Map(parsed.entries)
  } catch {
    return new Map()
  }
}

function savePartialIdMap(userId: string, idMap: Map<string, string>): void {
  try {
    const payload: PartialIdMap = { userId, entries: [...idMap] }
    window.localStorage.setItem(PARTIAL_KEY, JSON.stringify(payload))
  } catch { /* best effort */ }
}

function clearPartialIdMap(): void {
  try { window.localStorage.removeItem(PARTIAL_KEY) } catch { /* best effort */ }
}

export async function migrateLocalToCloud(cloud: SessionStore, userId: string): Promise<void> {
  if (hasMigrated()) return
  // Resume rather than restart. onAuthStateChange fires on every page load,
  // not just on sign-in, so a migration that fails *permanently* (say a local
  // session id that isn't a UUID, from sessions.ts's makeId() fallback) would
  // otherwise re-run forever, minting a fresh duplicate of every project on
  // each load. Reusing the projects a previous attempt already created bounds
  // that duplication to zero.
  const idMap = loadPartialIdMap(userId)
  try {
    const [localProjects, localSessions] = await Promise.all([
      localSessionStore.loadProjects(),
      localSessionStore.loadSessions(),
    ])
    // Projects first — sessions reference them by id, and the cloud store
    // mints new project ids on insert, so references must be remapped.
    for (const project of localProjects) {
      if (idMap.has(project.id)) continue  // already created by an earlier attempt
      const created = await cloud.createProject(project.name, project.description)
      idMap.set(project.id, created.id)
      // Persisted per project, not once at the end: a failure on the NEXT
      // project must not lose the ones already uploaded.
      savePartialIdMap(userId, idMap)
    }
    for (const session of localSessions) {
      await cloud.saveSession({
        ...session,
        projectId: session.projectId ? (idMap.get(session.projectId) ?? null) : null,
      })
    }
    markMigrated()
    clearPartialIdMap()
  } catch (err) {
    // Best-effort: a failed migration must not block sign-in. The flag is
    // deliberately NOT set here, so the next sign-in retries — and the partial
    // map is deliberately NOT cleared, so that retry resumes from it.
    console.error('Local-to-cloud migration failed', err)
  }
}
