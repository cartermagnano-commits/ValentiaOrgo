import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Orgo AI — Chemical Pathway Explorer',
    short_name: 'Orgo AI',
    description: 'Recognize structures, explore branching reaction pathways, and get grounded AI explanations.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f3f0e7',
    theme_color: '#1f6f5c',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }
}
