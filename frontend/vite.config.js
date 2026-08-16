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

export default defineConfig({
  plugins: [react()],
  base: '/agh/',
  server: {
    allowedHosts,
    proxy: {
      '/agh/api': apiTarget
    }
  }
})
