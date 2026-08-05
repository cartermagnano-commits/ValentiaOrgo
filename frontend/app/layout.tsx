import '../src/App.css'
import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { ToastProvider } from '../src/platform/Toast'
import ApiStatusBanner from '../src/platform/ApiStatusBanner'
import PwaRegister from '../src/platform/PwaRegister'

export const metadata: Metadata = {
  title: 'Orgo AI',
  description: 'Organic chemistry AI workspace',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Orgo AI', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  themeColor: '#1f6f5c',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <ApiStatusBanner />
          {children}
        </ToastProvider>
        <PwaRegister />
      </body>
    </html>
  )
}
