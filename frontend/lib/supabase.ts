// Single Supabase client for the browser — Auth plus direct table access
// (profiles/projects/chemistry_files/user_settings), guarded by Row Level
// Security. See docs/superpowers/specs/2026-09-04-user-profiles-design.md.
//
// NEXT_PUBLIC_* vars are safe to ship to the browser: the anon key grants no
// access by itself — RLS (auth.uid() = user_id on every table) is the actual
// boundary. See supabase/schema.sql.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

if (!url || !anonKey) {
  // Accounts are optional — the app works keyless/accountless out of the
  // box (see CLAUDE.md) — so this can't throw. A client built on placeholder
  // values fails every auth/db call at request time instead, which
  // AuthProvider (lib/auth.tsx) surfaces as an ordinary sign-in error rather
  // than a crashed page.
  console.warn(
    'NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY not set — ' +
    'sign-in is unavailable; the app still works fully signed-out.',
  )
}

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder')
