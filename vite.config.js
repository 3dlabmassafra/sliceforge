import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths: works on GitHub Pages (/sliceforge/) and Vercel alike.
  base: './',
  plugins: [react()],
  server: {
    // allow the sandboxed preview proxy host when running `npm run dev`
    allowedHosts: true,
  },
  preview: {
    // same for `vite preview` (static build serving)
    allowedHosts: true,
  },
  optimizeDeps: {
    // manifold-3d loads its own .wasm relative to import.meta.url —
    // pre-bundling would break that resolution.
    exclude: ['manifold-3d']
  }
})
