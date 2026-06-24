import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/analyze':   'http://localhost:8000',
      '/predict':   'http://localhost:8000',
      '/structure': 'http://localhost:8000',
      '/pathways':  'http://localhost:8000',
      '/explain':   'http://localhost:8000',
      '/chat':      'http://localhost:8000',
    },
  },
})
