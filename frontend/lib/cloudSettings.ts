// Reads/writes user_settings.engine — the one row of non-secret preference
// each account carries (currently just the preferred model). The BYOK API
// key is NEVER read or written here — see supabase/schema.sql's comment on
// user_settings and docs/superpowers/specs/2026-09-04-user-profiles-design.md.
import { supabase } from './supabase'

export async function loadCloudModel(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('engine')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const engine = data.engine as { model?: string } | null
  return engine?.model ?? null
}

export async function saveCloudModel(userId: string, model: string): Promise<void> {
  await supabase
    .from('user_settings')
    .upsert({ user_id: userId, engine: { model }, updated_at: new Date().toISOString() })
}
