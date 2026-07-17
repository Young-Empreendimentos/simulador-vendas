import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

export type Perfil = {
  id: number
  email: string
  nome: string | null
  papel: 'admin' | 'coordenador' | 'consultor'
  pode_autonomia: boolean
  pode_bonificar: boolean
  ativo: boolean
  empreendimentos: string[]   // vazio = todos liberados
  status: string
}

export const PODE_GERENCIAR = (p: Perfil | null) =>
  !!p && (p.papel === 'admin' || p.papel === 'coordenador')

// loading: verificando sessão | unauthenticated: sem login |
// pending: logado mas fora da allowlist | authorized: logado e liberado
type Status = 'loading' | 'unauthenticated' | 'pending' | 'authorized'

type AuthValue = {
  status: Status
  session: Session | null
  user: User | null
  perfil: Perfil | null
  signInGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [perfil, setPerfil] = useState<Perfil | null>(null)

  useEffect(() => {
    let ativo = true

    async function resolver(sess: Session | null) {
      if (!ativo) return
      setSession(sess)
      if (!sess) {
        setPerfil(null)
        setStatus('unauthenticated')
        return
      }
      // Filtra pela própria linha. (Admin enxerga todas as linhas via RLS, então
      // sem este filtro o maybeSingle receberia várias e falharia.)
      const email = (sess.user.email ?? '').toLowerCase()
      const { data, error } = await supabase
        .from('simulador_usuarios')
        .select('id,email,nome,papel,pode_autonomia,pode_bonificar,ativo,empreendimentos,status')
        .eq('email', email)
        .maybeSingle()
      if (!ativo) return
      if (error) {
        console.error('Erro ao ler perfil:', error.message)
        setPerfil(null)
        setStatus('pending')
        return
      }
      if (data && data.ativo) {
        setPerfil({ ...data, empreendimentos: data.empreendimentos ?? [] } as Perfil)
        setStatus('authorized')
      } else {
        setPerfil(null)
        setStatus('pending')
        // Sem linha ainda? Registra a solicitação de acesso (idempotente no servidor),
        // pra o admin ver o pedido no portal.
        if (!data) {
          const nome =
            (sess.user.user_metadata?.full_name as string | undefined) ??
            (sess.user.user_metadata?.name as string | undefined) ??
            null
          supabase.rpc('simulador_solicitar_acesso', { p_nome: nome }).then(({ error: e }) => {
            if (e) console.error('Falha ao solicitar acesso:', e.message)
          })
        }
      }
    }

    supabase.auth.getSession().then(({ data }) => resolver(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => resolver(sess))
    return () => {
      ativo = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const signInGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      // volta para a URL atual (funciona no domínio próprio e no /simulador-vendas/
      // do GitHub Pages). Precisa estar na allowlist de Redirect URLs do Supabase.
      options: { redirectTo: window.location.origin + window.location.pathname },
    })
  }
  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider
      value={{ status, session, user: session?.user ?? null, perfil, signInGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}
