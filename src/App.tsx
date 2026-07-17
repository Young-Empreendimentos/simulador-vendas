import { type ReactNode, useEffect, useState } from 'react'
import { useAuth, PODE_GERENCIAR } from './auth'
import { supabase } from './lib/supabase'
import Simulador from './Simulador'
import AdminUsuarios from './AdminUsuarios'

function Centro({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="pop-in w-full max-w-sm bg-[#0f1520] border border-white/[0.08] rounded-2xl p-8 text-center shadow-2xl shadow-black/40">
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
      <p className="text-white font-medium mb-1">Solicitação enviada</p>
      <p className="text-gray-400 text-sm mb-6">
        Sua solicitação de acesso foi registrada. Um administrador precisa aprovar a
        conta <span className="text-gray-200">{user?.email}</span>. Você entra assim que
        isso acontecer.
      </p>
      <button onClick={signOut} className="text-sm text-gray-400 hover:text-white">Sair</button>
    </Centro>
  )
}

function AppShell() {
  const { perfil, signOut } = useAuth()
  const gerente = PODE_GERENCIAR(perfil)
  const [view, setView] = useState<'sim' | 'admin'>('sim')
  const [pendentes, setPendentes] = useState(0)

  useEffect(() => {
    if (!gerente) return
    let ativo = true
    supabase.from('simulador_usuarios').select('id').eq('status', 'pendente').then(({ data }) => {
      if (ativo) setPendentes(data?.length ?? 0)
    })
    return () => { ativo = false }
  }, [gerente, view])

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-2.5 bg-[#0a0e16]/80 backdrop-blur-md border-b border-white/[0.08]">
        <span className="flex items-center gap-2 font-display font-bold text-sm text-[#fe5009] tracking-wide">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v3" /><circle cx="12" cy="2.2" r="1.1" fill="currentColor" stroke="none" /><rect x="4" y="6" width="16" height="12" rx="3" /><path d="M2 11v3" /><path d="M22 11v3" /><circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none" /></svg>
          Young
        </span>
        <div className="flex items-center gap-3 text-sm">
          {gerente && (
            <button
              onClick={() => setView((v) => (v === 'admin' ? 'sim' : 'admin'))}
              className="relative flex items-center gap-1.5 text-gray-300 hover:text-white transition-colors"
            >
              {view === 'admin' ? (
                <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" /></svg>Simulador</>
              ) : (
                <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>Usuários</>
              )}
              {view !== 'admin' && pendentes > 0 && (
                <span className="absolute -top-2 -right-2 bg-[#fe5009] text-white text-[10px] leading-none rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{pendentes}</span>
              )}
            </button>
          )}
          <span className="text-gray-300">{perfil?.nome ?? perfil?.email}</span>
          <span className="text-[10px] uppercase tracking-wider text-gray-400 border border-white/[0.12] rounded px-1.5 py-0.5">{perfil?.papel}</span>
          <button onClick={signOut} className="text-gray-400 hover:text-white">Sair</button>
        </div>
      </header>
      <main className="p-4">
        {view === 'admin' && gerente ? <AdminUsuarios onPendentes={setPendentes} /> : <Simulador />}
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
