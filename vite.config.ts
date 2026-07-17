import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Relativo: funciona tanto no domínio próprio (raiz) quanto no caminho do
  // GitHub Pages (/simulador-vendas/), sem quebrar os assets.
  base: './',
  plugins: [react(), tailwindcss()],
})
