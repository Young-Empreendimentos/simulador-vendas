import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'

// Nomes exatos como estão em comercial_tabela_precos (a função normaliza no servidor).
const EMPREENDIMENTOS = [
  'Algarve', 'Aurora', 'Erico Verissimo', 'Ilha dos Açores',
  'Montecarlo', 'Morada da Coxilha', 'Parque Lorena 2', 'Parque Lorena Itaqui',
]

type Reforco = { mes: string; valor: string }

type Resumo = {
  valor_lote_av: number
  valor_tabela: number
  entrada: number
  prazo_meses: number
  parcela_mensal: number
  total_parcelas: number
  total_reforcos: number
  itbi: number
  itbi_percentual: number
  cartorio: number
  total_pago: number
  multiplicador: number
}
type Resultado = {
  sucesso: true
  empreendimento: string
  num_lote: string
  promocional: boolean
  promo_descricao: string | null
  autonomia_aplicada: boolean
  resumo: Resumo
  reforcos: { mes: number; valor: string; data_str: string }[]
}

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function paramsIniciais() {
  const p = new URLSearchParams(window.location.search)
  const emp = p.get('empreendimento') ?? ''
  const empMatch = EMPREENDIMENTOS.find(
    (e) => e.toLowerCase() === emp.toLowerCase(),
  )
  return { empreendimento: empMatch ?? '', lote: p.get('lote') ?? '' }
}

export default function Simulador() {
  const { perfil } = useAuth()
  const inicial = useMemo(paramsIniciais, [])

  const [empreendimento, setEmpreendimento] = useState(inicial.empreendimento)
  const [numLote, setNumLote] = useState(inicial.lote)
  const [entrada, setEntrada] = useState('')
  const [prazo, setPrazo] = useState('')
  const [reforcos, setReforcos] = useState<Reforco[]>([])
  const [promocional, setPromocional] = useState(false)
  const [precoCustomizado, setPrecoCustomizado] = useState(false)
  const [valorCustom, setValorCustom] = useState('')

  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)

  const ehMontecarlo = empreendimento.toLowerCase() === 'montecarlo'
  const podeAutonomia = !!perfil?.pode_autonomia && ehMontecarlo

  // Se trocar de empreendimento e perder o direito, zera a autonomia.
  useEffect(() => {
    if (!podeAutonomia && precoCustomizado) {
      setPrecoCustomizado(false)
      setValorCustom('')
    }
  }, [podeAutonomia, precoCustomizado])

  function addReforco() {
    setReforcos((r) => [...r, { mes: '', valor: '' }])
  }
  function setReforco(i: number, campo: keyof Reforco, v: string) {
    setReforcos((r) => r.map((x, j) => (j === i ? { ...x, [campo]: v } : x)))
  }
  function delReforco(i: number) {
    setReforcos((r) => r.filter((_, j) => j !== i))
  }

  async function simular() {
    setErro(null)
    setResultado(null)
    if (!empreendimento) return setErro('Selecione o empreendimento.')
    if (!numLote.trim()) return setErro('Informe o número do lote.')

    const body: Record<string, unknown> = {
      empreendimento,
      num_lote: numLote.trim(),
      entrada: Number(entrada) || 0,
      promocional,
      preco_customizado: precoCustomizado,
    }
    if (precoCustomizado) body.valor_lote = Number(valorCustom) || 0
    body.prazo_meses = Number(prazo) || 0
    body.reforcos = reforcos
      .filter((r) => r.mes && r.valor)
      .map((r) => ({ mes: Number(r.mes), valor: Number(r.valor) }))

    setCarregando(true)
    try {
      const { data, error } = await supabase.functions.invoke('simular-financiamento', { body })
      if (error) {
        // Erros da função (400/403/404…) vêm no corpo da resposta.
        let msg = error.message
        try {
          const ctx = (error as { context?: Response }).context
          if (ctx && typeof ctx.json === 'function') {
            const corpo = await ctx.json()
            msg = corpo?.mensagem || corpo?.erro || msg
          }
        } catch { /* mantém msg padrão */ }
        setErro(msg)
        return
      }
      if (data?.erro) {
        setErro(data.mensagem || data.erro)
        return
      }
      setResultado(data as Resultado)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao simular.')
    } finally {
      setCarregando(false)
    }
  }

  const campo =
    'w-full bg-[#0d0d0d] border border-[#333] rounded-lg px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none'
  const label = 'block text-xs font-medium text-gray-400 mb-1'

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr] max-w-5xl">
      {/* ---- Formulário ---- */}
      <div className="bg-[#141414] border border-[#262626] rounded-xl p-5 space-y-4 h-fit">
        <h2 className="font-display text-white text-base">Nova simulação</h2>

        <div>
          <label className={label}>Empreendimento</label>
          <select
            className={campo}
            value={empreendimento}
            onChange={(e) => setEmpreendimento(e.target.value)}
          >
            <option value="">Selecione…</option>
            {EMPREENDIMENTOS.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Lote (nº)</label>
            <input className={campo} value={numLote} onChange={(e) => setNumLote(e.target.value)} placeholder="ex: 40" />
          </div>
          <div>
            <label className={label}>Entrada (R$)</label>
            <input className={campo} type="number" value={entrada} onChange={(e) => setEntrada(e.target.value)} placeholder="mín. 500" />
          </div>
        </div>

        <div>
          <label className={label}>Prazo (nº de parcelas)</label>
          <input className={campo} type="number" value={prazo} onChange={(e) => setPrazo(e.target.value)} placeholder="ex: 80" />
        </div>

        {/* reforços */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className={label + ' mb-0'}>Reforços (opcional)</span>
            <button type="button" onClick={addReforco} className="text-xs text-[#fe5009] hover:underline">+ adicionar</button>
          </div>
          {reforcos.map((r, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input className={campo} type="number" value={r.mes} onChange={(e) => setReforco(i, 'mes', e.target.value)} placeholder="mês" />
              <input className={campo} type="number" value={r.valor} onChange={(e) => setReforco(i, 'valor', e.target.value)} placeholder="valor R$" />
              <button type="button" onClick={() => delReforco(i)} className="text-gray-500 hover:text-red-400 px-1">✕</button>
            </div>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={promocional} onChange={(e) => setPromocional(e.target.checked)} />
          Aplicar promoção vigente
        </label>

        {podeAutonomia && (
          <div className="rounded-lg border border-[#004ebf]/40 bg-[#004ebf]/10 p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={precoCustomizado} onChange={(e) => setPrecoCustomizado(e.target.checked)} />
              Preço com autonomia (Montecarlo)
            </label>
            {precoCustomizado && (
              <input className={campo} type="number" value={valorCustom} onChange={(e) => setValorCustom(e.target.value)} placeholder="preço à vista (R$)" />
            )}
          </div>
        )}

        <button
          onClick={simular}
          disabled={carregando}
          className="w-full bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2.5 rounded-lg"
        >
          {carregando ? 'Calculando…' : 'Simular'}
        </button>

        {erro && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{erro}</p>
        )}
      </div>

      {/* ---- Resultado ---- */}
      <div>
        {!resultado ? (
          <div className="bg-[#141414] border border-dashed border-[#2a2a2a] rounded-xl p-8 text-center text-gray-500 text-sm h-full flex items-center justify-center">
            Preencha os dados e clique em <span className="text-gray-300 mx-1">Simular</span> para ver a proposta.
          </div>
        ) : (
          <div className="bg-[#141414] border border-[#262626] rounded-xl p-6 space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-display text-white text-lg">{resultado.empreendimento} · Lote {resultado.num_lote}</h2>
                <div className="flex gap-2 mt-1">
                  {resultado.promocional && (
                    <span className="text-[10px] uppercase tracking-wide text-[#00bcbc] border border-[#00bcbc]/40 rounded px-1.5 py-0.5">Promoção</span>
                  )}
                  {resultado.autonomia_aplicada && (
                    <span className="text-[10px] uppercase tracking-wide text-[#004ebf] border border-[#004ebf]/40 rounded px-1.5 py-0.5">Autonomia</span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Parcela mensal</p>
                <p className="font-display text-2xl text-[#fe5009]">{brl(resultado.resumo.parcela_mensal)}</p>
                <p className="text-xs text-gray-500">{resultado.resumo.prazo_meses}x</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#262626] rounded-lg overflow-hidden text-sm">
              {[
                ['Valor à vista', brl(resultado.resumo.valor_lote_av)],
                ['Entrada', brl(resultado.resumo.entrada)],
                ['Parcelas', `${resultado.resumo.prazo_meses}x de ${brl(resultado.resumo.parcela_mensal)}`],
                ['Total das parcelas', brl(resultado.resumo.total_parcelas)],
                ['Reforços', brl(resultado.resumo.total_reforcos)],
                [`ITBI (${resultado.resumo.itbi_percentual}%)`, brl(resultado.resumo.itbi)],
                ['Cartório', brl(resultado.resumo.cartorio)],
                ['Total a prazo', brl(resultado.resumo.total_pago)],
                ['Multiplicador', `${resultado.resumo.multiplicador}x`],
              ].map(([k, v]) => (
                <div key={k} className="bg-[#141414] p-3">
                  <p className="text-gray-500 text-xs">{k}</p>
                  <p className="text-white">{v}</p>
                </div>
              ))}
            </div>

            {resultado.reforcos.length > 0 && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Reforços</p>
                <ul className="text-sm text-gray-300 space-y-0.5">
                  {resultado.reforcos.map((r, i) => (
                    <li key={i}>Mês {r.mes}: {brl(Number(r.valor))}</li>
                  ))}
                </ul>
              </div>
            )}

            {resultado.promo_descricao && (
              <p className="text-xs text-[#00bcbc]">{resultado.promo_descricao}</p>
            )}

            <p className="text-[11px] text-gray-600 border-t border-[#262626] pt-3">
              ITBI e cartório embutidos nas parcelas. Simulação sem valor contratual — sujeita a conferência.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
