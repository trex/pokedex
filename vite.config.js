import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/pokedex/',
  server: {
    historyApiFallback: true,
  },
  preview: {
    historyApiFallback: true,
  }
})
