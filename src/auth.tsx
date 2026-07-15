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
}

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
      // RLS devolve APENAS a própria linha do usuário (por auth.uid()/email).
      const { data, error } = await supabase
        .from('simulador_usuarios')
        .select('id,email,nome,papel,pode_autonomia,pode_bonificar,ativo')
        .maybeSingle()
      if (!ativo) return
      if (error) {
        console.error('Erro ao ler perfil:', error.message)
        setPerfil(null)
        setStatus('pending')
        return
      }
      if (data && data.ativo) {
        setPerfil(data as Perfil)
        setStatus('authorized')
      } else {
        setPerfil(null)
        setStatus('pending')
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
      options: { redirectTo: window.location.origin },
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
