import '../src/App.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'Orgo AI',
  description: 'Project-based organic chemistry AI workspace',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
