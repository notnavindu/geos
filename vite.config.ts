import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // satellite.js 7 re-exports an optional WASM build whose worker uses top-level await, which only ES-module workers allow.
  worker: { format: 'es' },
})
