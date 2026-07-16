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

const brl = (n: number) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
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
  tem_corretor?: boolean
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
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [res, setRes] = useState<Resposta | null>(null)
  const [linkDoc, setLinkDoc] = useState<string | null>(null)

  function montarBody(gerar: boolean): Record<string, unknown> {
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
      gerar,
    }
    if (temCorretor) body.corretor_busca = corretorBusca.trim()
    if (temCorretor && perfil?.pode_bonificar) body.bonus_comissao = Number(bonus) || 0
    return body
  }

  async function chamar(gerar: boolean) {
    const { data, error } = await supabase.functions.invoke('gerar-contrato', { body: montarBody(gerar) })
    if (error) {
      let msg = error.message
      try {
        const ctx = (error as { context?: Response }).context
        if (ctx && typeof ctx.json === 'function') { const c = await ctx.json(); msg = c?.mensagem || c?.erro || msg }
      } catch { /* mantém msg */ }
      throw new Error(msg)
    }
    if (data?.erro) throw new Error((data.mensagem || data.erro) + (data.detalhe ? ' — ' + data.detalhe : ''))
    return data
  }

  async function preVisualizar() {
    setErro(null); setRes(null); setLinkDoc(null)
    if (!comprador1.trim()) return setErro('Informe o Comprador 1.')
    if (temCorretor && !corretorBusca.trim()) return setErro('Informe o CPF/CNPJ ou nome do corretor.')
    setCarregando(true)
    try {
      setRes(await chamar(false) as Resposta)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao montar o contrato.')
    } finally {
      setCarregando(false)
    }
  }

  async function gerarDocumento() {
    setErro(null); setLinkDoc(null)
    setGerando(true)
    try {
      const data = await chamar(true)
      if (data?.link) setLinkDoc(data.link as string)
      else setErro('Documento gerado, mas sem link de retorno.')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao gerar o documento.')
    } finally {
      setGerando(false)
    }
  }

  const campo = 'w-full bg-[#0d0d0d] border border-[#333] rounded-lg px-3 py-1.5 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none'
  const label = 'block text-[11px] font-medium text-gray-400 mb-1'
  const secao = 'font-display text-white text-xs uppercase tracking-wide text-gray-400'
  const req = <span className="text-[#fe5009]">*</span>
  const r = sim.resumo

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto p-4 sm:p-8" onClick={onClose}>
      <div className="mx-auto max-w-2xl bg-[#141414] border border-[#262626] rounded-2xl p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
        {/* Cabeçalho */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-white text-lg">Gerar contrato</h2>
            <p className="text-sm text-gray-400">{sim.empreendimento} · Lote {sim.num_lote}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Resumo da simulação (o que está sendo contratado) */}
        <div className="rounded-lg bg-[#0d0d0d] border border-[#262626] p-3">
          <p className={label + ' mb-2'}>Resumo da simulação</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><p className="text-gray-500 text-[11px]">Valor à vista</p><p className="text-white">{brl(r.valor_lote_av)}</p></div>
            <div><p className="text-gray-500 text-[11px]">Entrada</p><p className="text-white">{brl(r.entrada)}</p></div>
            <div><p className="text-gray-500 text-[11px]">Parcelas</p><p className="text-white">{r.prazo_meses}x {brl(r.parcela_mensal)}</p></div>
            <div><p className="text-gray-500 text-[11px]">ITBI + Cartório</p><p className="text-white">{brl(r.itbi + r.cartorio)}</p></div>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          Matrícula, área, ônus, vendedora, dados bancários e corretor são buscados automaticamente no sistema. Preencha só o que segue:
        </p>

        {/* Tipo */}
        <div>
          <p className={label}>Tipo de contrato</p>
          <div className="flex rounded-lg border border-[#333] overflow-hidden text-sm w-56">
            <button type="button" onClick={() => setTipo('aprazo')} className={`flex-1 py-1.5 ${tipo === 'aprazo' ? 'bg-[#fe5009] text-white' : 'text-gray-400'}`}>À prazo</button>
            <button type="button" onClick={() => setTipo('avista')} className={`flex-1 py-1.5 ${tipo === 'avista' ? 'bg-[#fe5009] text-white' : 'text-gray-400'}`}>À vista</button>
          </div>
        </div>

        {/* Compradores */}
        <div className="space-y-3">
          <h3 className={secao}>Compradores</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Comprador 1 {req}</label><input className={campo} value={comprador1} onChange={(e) => setComprador1(e.target.value)} /></div>
            <div><label className={label}>Comprador 2 (opcional)</label><input className={campo} value={comprador2} onChange={(e) => setComprador2(e.target.value)} /></div>
          </div>
          <div>
            <label className={label}>Qualificação dos clientes {req} <span className="text-gray-600">(entra no contrato)</span></label>
            <textarea className={campo + ' min-h-[70px]'} value={qualificacao} onChange={(e) => setQualificacao(e.target.value)} placeholder="nome, nacionalidade, estado civil, CPF, endereço…" />
          </div>
        </div>

        {/* Pagamento */}
        <div className="space-y-3">
          <h3 className={secao}>Datas de pagamento</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Data da entrada</label><input type="date" className={campo} value={dataEntrada} onChange={(e) => setDataEntrada(e.target.value)} /></div>
            {tipo === 'aprazo' && (
              <div><label className={label}>1º vencimento (parcelas)</label><input type="date" className={campo} value={dataPrimVenc} onChange={(e) => setDataPrimVenc(e.target.value)} /></div>
            )}
          </div>
          {sim.reforcos.length > 0 && (
            <p className="text-xs text-gray-500">Reforços (da simulação): {sim.reforcos.map((x) => `${x.data_str || 'mês ' + x.mes} (${brl(Number(x.valor))})`).join(', ')}</p>
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
                <label className={label}>Corretor — CPF/CNPJ ou nome {req}</label>
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
        {erro && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 whitespace-pre-wrap">{erro}</p>}

        {/* Conferência + prévia */}
        {res && (
          <div className="space-y-4 border-t border-[#262626] pt-4">
            {/* Dados buscados no sistema — para conferência */}
            <div className="rounded-lg border border-[#004ebf]/30 bg-[#004ebf]/5 p-3">
              <p className={label + ' mb-2'}>Dados buscados no sistema — confira</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div><p className="text-gray-500 text-[11px]">Matrícula</p><p className="text-white">{res.dados_lote?.matricula || '—'}</p></div>
                <div><p className="text-gray-500 text-[11px]">Área</p><p className="text-white">{res.dados_lote?.area || '—'}</p></div>
                <div><p className="text-gray-500 text-[11px]">Ônus</p><p className="text-white">{res.dados_lote?.onus || '—'}</p></div>
                <div><p className="text-gray-500 text-[11px]">Vendedora</p><p className="text-white capitalize">{res.proprietario || '—'} <span className="text-gray-600 text-[11px]">(do template)</span></p></div>
                {res.tem_corretor && <div><p className="text-gray-500 text-[11px]">Corretor</p><p className="text-white">{res.corretor_nome || '—'}</p></div>}
              </div>
              {res.dados_banco_empresa && (
                <p className="text-[11px] text-gray-500 mt-2">Dados bancários: <span className="text-gray-300">{res.dados_banco_empresa}</span></p>
              )}
            </div>

            {/* Cláusulas montadas */}
            <h3 className={secao}>Prévia das cláusulas</h3>
            {([
              ['3. Valor do Imóvel', res.campos.Valor_Imovel],
              ['4. Forma de Pagamento', res.campos.Forma_de_Pagamento],
              ['11. Honorários', res.campos.Honorarios],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <p className="text-xs text-gray-400 mb-1">{k}</p>
                <pre className="whitespace-pre-wrap text-sm text-gray-200 bg-[#0d0d0d] border border-[#262626] rounded-lg p-3 font-sans">{v}</pre>
              </div>
            ))}

            {linkDoc ? (
              <a href={linkDoc} target="_blank" rel="noopener noreferrer" className="block w-full text-center bg-[#00bcbc] hover:brightness-110 transition text-white font-medium py-2.5 rounded-lg">
                ✓ Contrato gerado — abrir no Google Docs
              </a>
            ) : (
              <button onClick={gerarDocumento} disabled={gerando} className="w-full bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2.5 rounded-lg">
                {gerando ? 'Gerando documento…' : 'Gerar documento no Google Docs'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
