import { type ReactNode } from 'react'
import { useAuth } from './auth'
import Simulador from './Simulador'

function Centro({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-[#141414] border border-[#262626] rounded-2xl p-8 text-center">
        {children}
      </div>
    </div>
  )
}

function Marca() {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      <span className="font-display font-bold text-2xl text-white">Simulador</span>
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#fe5009] border border-[#fe5009]/50 rounded px-1.5 py-0.5">Young</span>
    </div>
  )
}

function Loading() {
  return <Centro><p className="text-gray-400 text-sm">Carregando…</p></Centro>
}

function Login() {
  const { signInGoogle } = useAuth()
  return (
    <Centro>
      <Marca />
      <p className="text-gray-400 text-sm mb-6">Acesso restrito à equipe Young.</p>
      <button
        onClick={signInGoogle}
        className="w-full bg-[#fe5009] hover:bg-orange-600 transition text-white font-medium py-2.5 rounded-lg"
      >
        Entrar com Google
      </button>
    </Centro>
  )
}

function AcessoPendente() {
  const { user, signOut } = useAuth()
  return (
    <Centro>
      <Marca />
      <p className="text-white font-medium mb-1">Acesso pendente</p>
      <p className="text-gray-400 text-sm mb-6">
        A conta <span className="text-gray-200">{user?.email}</span> ainda não tem
        permissão. Peça a um administrador para liberar seu acesso.
      </p>
      <button onClick={signOut} className="text-sm text-gray-400 hover:text-white">Sair</button>
    </Centro>
  )
}

function AppShell() {
  const { perfil, signOut } = useAuth()
  return (
    <div className="min-h-full">
      <header className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-[#061b39] to-[#0d0d0d] border-b border-[#232323]">
        <span className="font-display font-bold text-lg text-white">Simulador de Vendas</span>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-300">{perfil?.nome ?? perfil?.email}</span>
          <span className="text-[10px] uppercase tracking-wider text-gray-400 border border-[#333] rounded px-1.5 py-0.5">{perfil?.papel}</span>
          <button onClick={signOut} className="text-gray-400 hover:text-white">Sair</button>
        </div>
      </header>
      <main className="p-6">
        <Simulador />
      </main>
    </div>
  )
}

export default function App() {
  const { status } = useAuth()
  if (status === 'loading') return <Loading />
  if (status === 'unauthenticated') return <Login />
  if (status === 'pending') return <AcessoPendente />
  return <AppShell />
}
