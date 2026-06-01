import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/agh/',
  server: {
    proxy: {
      '/agh/api': 'http://localhost:5055'
    }
  }
})
