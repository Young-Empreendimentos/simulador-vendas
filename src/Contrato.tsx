import { useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'

// Tipo mínimo da simulação escolhida
export type SimParaContrato = {
  empreendimento: string
  num_lote: string
  resumo: {
    valor_lote_av: number
    entrada: number
    parcela_mensal: number
    prazo_meses: number
    itbi: number
    cartorio: number
  }
  reforcos: { mes: number; valor: string; data_str: string }[]
}

const brDate = (iso: string) => {
  if (!iso) return ''
  const [a, m, d] = iso.split('-')
  return a && m && d ? `${d}/${m}/${a}` : iso
}
const hojeISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const maisMesesISO = (n: number) => {
  const d = new Date()
  const b = new Date(d.getFullYear(), d.getMonth() + n, d.getDate())
  return `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, '0')}-${String(b.getDate()).padStart(2, '0')}`
}

type Campos = Record<string, string>
type Resposta = {
  campos: Campos
  dados_lote?: { matricula: string; area: string; onus: string }
  dados_banco_empresa?: string
  corretor_nome?: string | null
  proprietario?: string
  _calc?: Record<string, string>
}

export default function Contrato({ sim, onClose }: { sim: SimParaContrato; onClose: () => void }) {
  const { perfil } = useAuth()

  const [tipo, setTipo] = useState<'aprazo' | 'avista'>('aprazo')
  const [comprador1, setComprador1] = useState('')
  const [comprador2, setComprador2] = useState('')
  const [qualificacao, setQualificacao] = useState('')
  const [dataEntrada, setDataEntrada] = useState(hojeISO())
  const [dataPrimVenc, setDataPrimVenc] = useState(maisMesesISO(1))
  const [temCorretor, setTemCorretor] = useState(false)
  const [corretorBusca, setCorretorBusca] = useState('')
  const [bonus, setBonus] = useState('')

  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [res, setRes] = useState<Resposta | null>(null)

  async function preVisualizar() {
    setErro(null); setRes(null)
    if (!comprador1.trim()) return setErro('Informe o Comprador 1.')
    if (temCorretor && !corretorBusca.trim()) return setErro('Informe o CPF/CNPJ ou nome do corretor.')

    const body: Record<string, unknown> = {
      tipo_contrato: tipo,
      empreendimento: sim.empreendimento,
      num_lote: sim.num_lote,
      valor_lote_av: sim.resumo.valor_lote_av,
      entrada_bruta: tipo === 'avista' ? sim.resumo.valor_lote_av : sim.resumo.entrada,
      parcela_mensal: sim.resumo.parcela_mensal,
      prazo_meses: sim.resumo.prazo_meses,
      itbi: sim.resumo.itbi,
      cartorio: sim.resumo.cartorio,
      reforcos: sim.reforcos.map((r) => ({ valor: Number(r.valor), data_str: r.data_str })),
      data_entrada: brDate(dataEntrada),
      data_primeiro_vencimento: brDate(dataPrimVenc),
      Qualificacao_Clientes: qualificacao,
      Comprador1: comprador1,
      Comprador2: comprador2,
      tem_corretor: temCorretor,
    }
    if (temCorretor) body.corretor_busca = corretorBusca.trim()
    if (temCorretor && perfil?.pode_bonificar) body.bonus_comissao = Number(bonus) || 0

    setCarregando(true)
    try {
      const { data, error } = await supabase.functions.invoke('gerar-contrato', { body })
      if (error) {
        let msg = error.message
        try {
          const ctx = (error as { context?: Response }).context
          if (ctx && typeof ctx.json === 'function') { const c = await ctx.json(); msg = c?.mensagem || c?.erro || msg }
        } catch { /* mantém msg */ }
        setErro(msg)
        return
      }
      if (data?.erro) { setErro(data.mensagem || data.erro); return }
      setRes(data as Resposta)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao montar o contrato.')
    } finally {
      setCarregando(false)
    }
  }

  const campo = 'w-full bg-[#0d0d0d] border border-[#333] rounded-lg px-3 py-1.5 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none'
  const label = 'block text-[11px] font-medium text-gray-400 mb-1'
  const secao = 'font-display text-white text-sm border-b border-[#262626] pb-1'

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto p-4 sm:p-8" onClick={onClose}>
      <div className="mx-auto max-w-2xl bg-[#141414] border border-[#262626] rounded-2xl p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-white text-lg">Gerar contrato</h2>
            <p className="text-sm text-gray-400">{sim.empreendimento} · Lote {sim.num_lote} · {tipo === 'avista' ? 'à vista' : 'à prazo'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        <p className="text-xs text-gray-500">
          Matrícula, área, ônus, vendedora e dados bancários são buscados automaticamente no banco. Preencha só o que segue:
        </p>

        {/* tipo */}
        <div className="flex rounded-lg border border-[#333] overflow-hidden text-sm w-56">
          <button type="button" onClick={() => setTipo('aprazo')} className={`flex-1 py-1.5 ${tipo === 'aprazo' ? 'bg-[#fe5009] text-white' : 'text-gray-400'}`}>À prazo</button>
          <button type="button" onClick={() => setTipo('avista')} className={`flex-1 py-1.5 ${tipo === 'avista' ? 'bg-[#fe5009] text-white' : 'text-gray-400'}`}>À vista</button>
        </div>

        {/* Compradores */}
        <div className="space-y-3">
          <h3 className={secao}>Compradores</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Comprador 1</label><input className={campo} value={comprador1} onChange={(e) => setComprador1(e.target.value)} /></div>
            <div><label className={label}>Comprador 2 (opcional)</label><input className={campo} value={comprador2} onChange={(e) => setComprador2(e.target.value)} /></div>
          </div>
          <div>
            <label className={label}>Qualificação dos clientes (texto do contrato)</label>
            <textarea className={campo + ' min-h-[70px]'} value={qualificacao} onChange={(e) => setQualificacao(e.target.value)} placeholder="nome, nacionalidade, estado civil, CPF, endereço…" />
          </div>
        </div>

        {/* Datas de pagamento */}
        <div className="space-y-3">
          <h3 className={secao}>Pagamento</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Data da entrada</label><input type="date" className={campo} value={dataEntrada} onChange={(e) => setDataEntrada(e.target.value)} /></div>
            {tipo === 'aprazo' && (
              <div><label className={label}>1º vencimento (parcelas)</label><input type="date" className={campo} value={dataPrimVenc} onChange={(e) => setDataPrimVenc(e.target.value)} /></div>
            )}
          </div>
          {sim.reforcos.length > 0 && (
            <p className="text-xs text-gray-500">Reforços (da simulação): {sim.reforcos.map((r) => r.data_str).join(', ')}</p>
          )}
        </div>

        {/* Intermediação */}
        <div className="space-y-3">
          <h3 className={secao}>Intermediação</h3>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={temCorretor} onChange={(e) => setTemCorretor(e.target.checked)} />
            Tem corretor / imobiliária externa
          </label>
          {temCorretor && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[220px]">
                <label className={label}>Corretor (CPF/CNPJ ou nome)</label>
                <input className={campo} value={corretorBusca} onChange={(e) => setCorretorBusca(e.target.value)} placeholder="ex: 026.996.530-04 ou João da Silva" />
              </div>
              {perfil?.pode_bonificar && (
                <div className="w-40">
                  <label className={label}>Bônus na comissão (R$)</label>
                  <input className={campo} type="number" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="opcional" />
                </div>
              )}
            </div>
          )}
        </div>

        <button onClick={preVisualizar} disabled={carregando} className="w-full bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2.5 rounded-lg">
          {carregando ? 'Montando…' : 'Pré-visualizar contrato'}
        </button>
        {erro && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{erro}</p>}

        {/* Prévia */}
        {res && (
          <div className="space-y-4 border-t border-[#262626] pt-4">
            <h3 className={secao}>Prévia do contrato</h3>
            {res.dados_lote && (
              <p className="text-xs text-gray-500">
                Do banco → matrícula {res.dados_lote.matricula || '—'} · área {res.dados_lote.area || '—'} · ônus {res.dados_lote.onus}
                {res.corretor_nome ? ` · corretor ${res.corretor_nome}` : ''}
              </p>
            )}
            {([
              ['3. Valor do Imóvel', res.campos.Valor_Imovel],
              ['4. Forma de Pagamento', res.campos.Forma_de_Pagamento],
              ['11. Honorários', res.campos.Honorarios],
              ['Qualificação da Vendedora', res.campos.Qualificacao_Vendedora],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <p className="text-xs text-gray-400 mb-1">{k}</p>
                <pre className="whitespace-pre-wrap text-sm text-gray-200 bg-[#0d0d0d] border border-[#262626] rounded-lg p-3 font-sans">{v}</pre>
              </div>
            ))}
            <button disabled title="Disponível após configurar a conta de serviço do Google" className="w-full border border-[#333] text-gray-500 py-2.5 rounded-lg cursor-not-allowed">
              Gerar documento no Google Docs (disponível após configurar o Google)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
