import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.AGH_API_TARGET || 'http://localhost:5055'
const defaultAllowedHosts = [
  'windows-zhaovr',
  'windows-zhaovr.tailefdc25.ts.net',
  '.ts.net'
]
const extraAllowedHosts = (process.env.AGH_ALLOWED_HOSTS || '')
  .split(',')
  .map(host => host.trim())
  .filter(Boolean)
const allowedHosts = [...new Set([...defaultAllowedHosts, ...extraAllowedHosts])]
const port = Number(process.env.AGH_FRONTEND_PORT) || 5173
const proxy = { '/agh/api': apiTarget }

export default defineConfig({
  plugins: [react()],
  base: '/agh/',
  server: {
    port,
    allowedHosts,
    proxy
  },
  // `npm run serve`: the production build on the dev server's port, for
  // remote access through a proxy (2-3 requests instead of ~50 modules).
  preview: {
    port,
    strictPort: true,
    allowedHosts,
    proxy
  }
})
