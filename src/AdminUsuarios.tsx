import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { EMPREENDIMENTOS } from './empreendimentos'

type Papel = 'admin' | 'coordenador' | 'consultor'
type Usuario = {
  id: number
  email: string
  nome: string | null
  papel: Papel
  pode_autonomia: boolean
  pode_bonificar: boolean
  ativo: boolean
  status: string
  empreendimentos: string[] | null
  created_at: string
}

const PAPEIS: { v: Papel; l: string }[] = [
  { v: 'consultor', l: 'Consultor' },
  { v: 'coordenador', l: 'Coordenador' },
  { v: 'admin', l: 'Admin' },
]

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 text-sm text-gray-300"
    >
      <span className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${on ? 'bg-[#fe5009]' : 'bg-[#2a3342]'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  )
}

function badgeStatus(s: string) {
  if (s === 'pendente') return 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10'
  if (s === 'bloqueado') return 'text-red-300 border-red-500/40 bg-red-500/10'
  return 'text-[#26e0a3] border-[#26e0a3]/40 bg-[#26e0a3]/10'
}

function LinhaUsuario({ u, onChanged }: { u: Usuario; onChanged: () => void }) {
  const [papel, setPapel] = useState<Papel>(u.papel)
  const [autonomia, setAutonomia] = useState(u.pode_autonomia)
  const [bonificar, setBonificar] = useState(u.pode_bonificar)
  const [todos, setTodos] = useState((u.empreendimentos ?? []).length === 0)
  const [emps, setEmps] = useState<string[]>(u.empreendimentos ?? [])
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const dirty =
    papel !== u.papel ||
    autonomia !== u.pode_autonomia ||
    bonificar !== u.pode_bonificar ||
    todos !== ((u.empreendimentos ?? []).length === 0) ||
    (!todos && emps.slice().sort().join('|') !== (u.empreendimentos ?? []).slice().sort().join('|'))

  const toggleEmp = (e: string) =>
    setEmps((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))

  async function persistir(extra: Partial<Usuario>) {
    if (!todos && emps.length === 0 && !('ativo' in extra && extra.ativo === false)) {
      setMsg('Selecione ao menos um empreendimento ou marque "Todos".')
      return
    }
    setSalvando(true)
    setMsg(null)
    const patch: Record<string, unknown> = {
      papel,
      pode_autonomia: autonomia,
      pode_bonificar: bonificar,
      empreendimentos: todos ? [] : emps,
      updated_at: new Date().toISOString(),
      ...extra,
    }
    const { error } = await supabase.from('simulador_usuarios').update(patch).eq('id', u.id)
    setSalvando(false)
    if (error) { setMsg('Erro ao salvar: ' + error.message); return }
    onChanged()
  }

  const aprovar = () => persistir({ ativo: true, status: 'ativo' })
  const bloquear = () => persistir({ ativo: false, status: 'bloqueado' })
  const salvar = () => persistir({})

  const pendente = u.status === 'pendente'
  const bloqueado = u.status === 'bloqueado'

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${pendente ? 'border-yellow-500/40 bg-[#141b12]' : 'border-white/[0.08] bg-[#0f1520]'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium truncate">{u.nome || u.email}</p>
          <p className="text-gray-500 text-xs truncate">{u.email}</p>
        </div>
        <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${badgeStatus(u.status)}`}>{u.status}</span>
      </div>

      {/* Papel */}
      <div className="flex items-center gap-1 bg-[#0b111b] border border-white/[0.07] rounded-lg p-0.5 w-fit">
        {PAPEIS.map((p) => (
          <button
            key={p.v}
            type="button"
            onClick={() => setPapel(p.v)}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${papel === p.v ? 'bg-[#fe5009] text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {p.l}
          </button>
        ))}
      </div>

      {/* Flags */}
      <div className="flex items-center gap-5 flex-wrap">
        <Switch on={autonomia} onChange={setAutonomia} label="Autonomia" />
        <Switch on={bonificar} onChange={setBonificar} label="Bônus" />
      </div>

      {/* Empreendimentos */}
      <div className="space-y-2">
        <Switch on={todos} onChange={setTodos} label="Todos os empreendimentos" />
        {!todos && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 pt-1">
            {EMPREENDIMENTOS.map((e) => (
              <label key={e} className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={emps.includes(e)} onChange={() => toggleEmp(e)} />
                <span className="truncate">{e}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {msg && <p className="text-xs text-yellow-400">{msg}</p>}

      {/* Ações */}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {pendente ? (
          <>
            <button onClick={aprovar} disabled={salvando} className="bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition">
              {salvando ? '…' : 'Aprovar acesso'}
            </button>
            <button onClick={bloquear} disabled={salvando} className="border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm px-3 py-1.5 rounded-lg transition">Recusar</button>
          </>
        ) : (
          <>
            <button onClick={salvar} disabled={salvando || !dirty} className="bg-[#fe5009] hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition">
              {salvando ? '…' : dirty ? 'Salvar' : 'Salvo'}
            </button>
            {bloqueado ? (
              <button onClick={aprovar} disabled={salvando} className="border border-[#26e0a3]/40 text-[#26e0a3] hover:bg-[#26e0a3]/10 text-sm px-3 py-1.5 rounded-lg transition">Reativar</button>
            ) : (
              <button onClick={bloquear} disabled={salvando} className="border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm px-3 py-1.5 rounded-lg transition">Bloquear</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function AdminUsuarios({ onPendentes }: { onPendentes?: (n: number) => void }) {
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  async function carregar() {
    const { data, error } = await supabase
      .from('simulador_usuarios')
      .select('id,email,nome,papel,pode_autonomia,pode_bonificar,ativo,status,empreendimentos,created_at')
      .order('created_at', { ascending: true })
    if (error) setErro(error.message)
    else { setUsuarios((data ?? []) as Usuario[]); setErro(null) }
    setCarregando(false)
  }
  useEffect(() => { carregar() }, [])

  const pendentes = usuarios.filter((u) => u.status === 'pendente')
  const demais = usuarios.filter((u) => u.status !== 'pendente')
  useEffect(() => { onPendentes?.(pendentes.length) }, [pendentes.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fe5009" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
        <h1 className="font-display text-white text-lg">Portal de usuários</h1>
      </div>

      {erro && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{erro}</div>}
      {carregando && <p className="text-gray-500 text-sm">Carregando…</p>}

      {!carregando && pendentes.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] uppercase tracking-wider text-yellow-400">Solicitações pendentes ({pendentes.length})</p>
          {pendentes.map((u) => <LinhaUsuario key={u.id} u={u} onChanged={carregar} />)}
        </div>
      )}

      {!carregando && (
        <div className="space-y-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Equipe ({demais.length})</p>
          {demais.map((u) => <LinhaUsuario key={u.id} u={u} onChanged={carregar} />)}
          {demais.length === 0 && <p className="text-gray-600 text-sm">Nenhum usuário ativo ainda.</p>}
        </div>
      )}
    </div>
  )
}
