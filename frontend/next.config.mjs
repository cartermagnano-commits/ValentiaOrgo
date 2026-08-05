const apiBase = process.env.NEXT_PUBLIC_ORGO_API_BASE_URL ?? 'http://127.0.0.1:8000'

const apiPaths = [
  'analyze',
  'predict',
  'structure',
  'molfile',
  'pathways',
  'explain',
  'stereo',
  'chat',
  'assist',
  'react',
  'react-from-image',
  // Each entry is an exact path match, so '/react' does NOT cover '/react/assess'.
  'react/assess',
  'engine/ollama-status',
  'engine/usage',
  'engine/template-gaps',
  'health',
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      ...apiPaths.map(path => ({
        source: `/${path}`,
        destination: `${apiBase}/${path}`,
      })),
      // Deferred image-recognition verification (dynamic token segment)
      {
        source: '/analyze/verify/:token',
        destination: `${apiBase}/analyze/verify/:token`,
      },
    ]
  },
}

export default nextConfig
