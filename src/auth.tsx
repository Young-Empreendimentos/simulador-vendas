import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, comercialDb } from './lib/supabase'

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
  // Último usuário já resolvido (perfil carregado). Serve para NÃO recarregar o acesso
  // quando o supabase-js re-emite SIGNED_IN/TOKEN_REFRESHED ao voltar o foco da aba.
  const carregadoRef = useRef<string | null>(null)

  useEffect(() => {
    let ativo = true

    async function resolver(sess: Session | null) {
      if (!ativo) return
      setSession(sess)
      if (!sess) {
        carregadoRef.current = null
        setPerfil(null)
        setStatus('unauthenticated')
        return
      }
      carregadoRef.current = sess.user.id
      // Filtra pela própria linha. (Admin enxerga todas as linhas via RLS, então
      // sem este filtro o maybeSingle receberia várias e falharia.)
      const email = (sess.user.email ?? '').toLowerCase()
      const { data, error } = await comercialDb
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
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => {
      // Foco de aba: o supabase-js re-emite SIGNED_IN/TOKEN_REFRESHED do MESMO usuário quando
      // a aba volta ao foco (trocar de aba, abrir WhatsApp Web, minimizar). Nesse caso só
      // atualizamos a sessão (token novo) e NÃO recarregamos o acesso — senão a tela de
      // "carregando" voltaria e o formulário seria desmontado, perdendo o que está digitado.
      // (ver skill banco-supabase). Só recarrega em login novo / troca de usuário / logout.
      if (sess && sess.user.id === carregadoRef.current) {
        setSession(sess)
        return
      }
      resolver(sess)
    })
    return () => {
      ativo = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const signInGoogle = async () => {
    // Preserva o deep-link do Lotfinder (?empreendimento=&lote=) através do redirect
    // do OAuth, que descarta a query. O Simulador recupera isso em paramsIniciais.
    try {
      if (/empreendimento=|lote=/.test(window.location.search)) {
        sessionStorage.setItem('sim_prefill', window.location.search)
      }
    } catch { /* sessionStorage indisponível */ }
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      // volta para a URL atual (funciona no domínio próprio e no /simulador-vendas/
      // do GitHub Pages). Precisa estar na allowlist de Redirect URLs do Supabase.
      options: { redirectTo: window.location.origin + window.location.pathname },
    })
  }
  const signOut = async () => {
    // SSO: escopo LOCAL — sai só deste navegador/sessão. signOut() sem escopo é GLOBAL e
    // derruba a pessoa de TODOS os sistemas Young (já causou incidente). Nunca sem escopo.
    await supabase.auth.signOut({ scope: 'local' })
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
