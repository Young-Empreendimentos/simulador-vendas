import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  throw new Error('Faltam VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY no .env')
}

// Cliente do navegador. Usa a chave publishable (anon) SÓ para login e para ler a
// própria linha de permissão (RLS por auth.uid()/email). Não lê nada sensível —
// todo dado de negócio passa por Edge Functions com service_role no servidor.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

// As tabelas do sistema (simulador_usuarios / simulador_notificacoes e todo o cadastro
// comercial) vivem no schema `comercial`, exposto na API. Use ESTE cliente para elas.
// Login (supabase.auth) e RPCs (supabase.rpc) continuam no schema `public` — não passe
// por aqui, senão o PostgREST procura a função no schema errado.
export const comercialDb = supabase.schema('comercial')
