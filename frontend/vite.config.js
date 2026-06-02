import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.AGH_API_TARGET || 'http://localhost:5055'

export default defineConfig({
  plugins: [react()],
  base: '/agh/',
  server: {
    proxy: {
      '/agh/api': apiTarget
    }
  }
})
