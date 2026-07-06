'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import AppTopbar from '../../src/platform/AppTopbar'
import EngineSettings from '../../src/platform/EngineSettings'
import { getCurrentUser } from '../../lib/database'

export default function SettingsRoute() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    getCurrentUser().then(u => {
      if (!u) router.replace('/login')
      else setUser(u)
    })
  }, [router])

  return (
    <div>
      <AppTopbar email={user?.email} />
      <EngineSettings />
    </div>
  )
}
