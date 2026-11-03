/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app is a pure client-side SPA (no SSR/server actions) that calls
  // /api/* on its own origin, so it's built as static files and served
  // directly by the Flask backend — one container, one process, no Node
  // runtime needed in production. See Dockerfile.
  output: 'export',
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
