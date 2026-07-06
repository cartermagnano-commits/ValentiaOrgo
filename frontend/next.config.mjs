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
  'engine/ollama-status',
  'engine/usage',
  'health',
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return apiPaths.map(path => ({
      source: `/${path}`,
      destination: `${apiBase}/${path}`,
    }))
  },
}

export default nextConfig
