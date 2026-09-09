import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth'
import CelebracaoVenda from './components/CelebracaoVenda'
import { supabase } from './lib/supabase'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
      <CelebracaoVenda supabase={supabase} sistema="Simulador" somUrl="/sons/venda-celebracao.mp3" />
    </AuthProvider>
  </StrictMode>,
)
