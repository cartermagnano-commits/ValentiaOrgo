const apiBase = process.env.NEXT_PUBLIC_ORGO_API_BASE_URL ?? 'http://127.0.0.1:8000'

const apiPaths = [
  'analyze',
  'predict',
  'structure',
  'pathways',
  'explain',
  'chat',
  'react',
  'react-from-image',
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
