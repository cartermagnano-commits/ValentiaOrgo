'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import AppTopbar from '../../src/platform/AppTopbar'
import EngineSettings from '../../src/platform/EngineSettings'
import Splash from '../../src/platform/Splash'
import { getCurrentUser } from '../../lib/database'

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const onboarding = searchParams.get('onboarding') === '1'
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
      <EngineSettings
        onboarding={onboarding}
        onDone={() => router.replace('/dashboard')}
      />
    </div>
  )
}

export default function SettingsRoute() {
  return (
    <Suspense fallback={<Splash message="Loading settings…" />}>
      <SettingsContent />
    </Suspense>
  )
}
