// API proxying lives in middleware.ts, NOT here: rewrites() cannot add the
// x-orgo-proxy-secret request header the backend requires. The matcher in
// middleware.ts is the path allowlist that used to live in this file.

/** @type {import('next').NextConfig} */
const nextConfig = {}

export default nextConfig
