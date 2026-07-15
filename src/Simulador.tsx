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
type Interno = {
  base_comissao: number
  comissao: number
  bonus: number
  comissao_total: number
}
type Resultado = {
  sucesso: true
  empreendimento: string
  num_lote: string
  promocional: boolean
  promo_descricao: string | null
  autonomia_aplicada: boolean
  status_lote: string | null
  disponivel: boolean
  interno: Interno
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

// Ícone de olho (abre/fecha a comissão)
function Olho({ aberto }: { aberto: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {!aberto && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  )
}

// Card de uma simulação (com a comissão escondida atrás do olhinho)
function CardSimulacao({ r }: { r: Resultado }) {
  const [verComissao, setVerComissao] = useState(false)
  return (
    <div className="bg-[#141414] border border-[#262626] rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-display text-white text-lg">{r.empreendimento} · Lote {r.num_lote}</h2>
          <div className="flex gap-2 mt-1">
            {r.promocional && (
              <span className="text-[10px] uppercase tracking-wide text-[#00bcbc] border border-[#00bcbc]/40 rounded px-1.5 py-0.5">Promoção</span>
            )}
            {r.autonomia_aplicada && (
              <span className="text-[10px] uppercase tracking-wide text-[#004ebf] border border-[#004ebf]/40 rounded px-1.5 py-0.5">Autonomia</span>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Parcela mensal</p>
          <p className="font-display text-2xl text-[#fe5009]">{brl(r.resumo.parcela_mensal)}</p>
          <p className="text-xs text-gray-500">{r.resumo.prazo_meses}x</p>
        </div>
      </div>

      {!r.disponivel && r.status_lote && (
        <p className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
          ⚠️ Atenção: este lote está como <strong>{r.status_lote}</strong> no Sienge — confirme a disponibilidade antes de prosseguir.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#262626] rounded-lg overflow-hidden text-sm">
        {[
          ['Valor à vista', brl(r.resumo.valor_lote_av)],
          ['Entrada', brl(r.resumo.entrada)],
          ['Parcelas', `${r.resumo.prazo_meses}x de ${brl(r.resumo.parcela_mensal)}`],
          ['Total em parcelas', brl(r.resumo.total_parcelas)],
          ...(r.resumo.total_reforcos > 0 ? [['Reforços', brl(r.resumo.total_reforcos)]] : []),
        ].map(([k, v]) => (
          <div key={k} className="bg-[#141414] p-3">
            <p className="text-gray-500 text-xs">{k}</p>
            <p className="text-white">{v}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-[#262626] divide-y divide-[#262626] text-sm">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-gray-400">📋 Custos de registro (ITBI + Cartório)</span>
          <span className="text-white">{brl(r.resumo.itbi + r.resumo.cartorio)}</span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5 bg-[#0d0d0d]">
          <span className="text-gray-200">💳 Valor total do financiamento</span>
          <span className="text-white font-display text-base">{brl(r.resumo.total_pago)}</span>
        </div>
      </div>

      {r.reforcos.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-1">Reforços</p>
          <ul className="text-sm text-gray-300 space-y-0.5">
            {r.reforcos.map((x, i) => (
              <li key={i}>Mês {x.mes}: {brl(Number(x.valor))}</li>
            ))}
          </ul>
        </div>
      )}

      {r.promo_descricao && <p className="text-xs text-[#00bcbc]">{r.promo_descricao}</p>}

      {/* Comissão (interna) — escondida atrás do olhinho */}
      <div className="border-t border-[#262626] pt-3">
        <button
          onClick={() => setVerComissao((v) => !v)}
          className="text-xs text-gray-400 hover:text-white flex items-center gap-1.5"
        >
          <Olho aberto={verComissao} />
          {verComissao ? 'ocultar comissão' : 'ver comissão (interno)'}
        </button>
        {verComissao && (
          <div className="mt-2 rounded-lg border border-[#333] bg-[#0d0d0d] p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-400">Comissão (5%)</span>
              <span className="text-white">{brl(r.interno.comissao)}</span>
            </div>
            {r.interno.bonus > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Bônus</span>
                <span className="text-white">{brl(r.interno.bonus)}</span>
              </div>
            )}
            {r.interno.bonus > 0 && (
              <div className="flex justify-between border-t border-[#262626] mt-1 pt-1">
                <span className="text-gray-300">Total</span>
                <span className="text-[#fe5009]">{brl(r.interno.comissao_total)}</span>
              </div>
            )}
            <p className="text-[10px] text-gray-600 pt-1">Informação interna — não faz parte da proposta ao cliente.</p>
          </div>
        )}
      </div>

      <p className="text-[11px] text-gray-600">
        ITBI e cartório embutidos nas parcelas. Simulação sem valor contratual — sujeita a conferência.
      </p>
    </div>
  )
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
  const [bonus, setBonus] = useState('')

  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [resultados, setResultados] = useState<Resultado[]>([])
  const [confirmacao, setConfirmacao] = useState<{ status_lote: string; mensagem: string } | null>(null)

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

  async function simular(confirmarFlag = false) {
    setErro(null)
    if (!confirmarFlag) setConfirmacao(null)
    if (!empreendimento) return setErro('Selecione o empreendimento.')
    if (!numLote.trim()) return setErro('Informe o número do lote.')

    const body: Record<string, unknown> = {
      empreendimento,
      num_lote: numLote.trim(),
      entrada: Number(entrada) || 0,
      promocional,
      preco_customizado: precoCustomizado,
      confirmar: confirmarFlag,
    }
    if (precoCustomizado) body.valor_lote = Number(valorCustom) || 0
    if (perfil?.pode_bonificar) body.bonus = Number(bonus) || 0
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
      // Lote não disponível: pede confirmação antes de calcular.
      if (data?.requer_confirmacao) {
        setConfirmacao({ status_lote: data.status_lote, mensagem: data.mensagem })
        return
      }
      if (data?.erro) {
        setErro(data.mensagem || data.erro)
        return
      }
      setConfirmacao(null)
      setResultados((prev) => [data as Resultado, ...prev]) // mais recente no topo
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
      <div className="bg-[#141414] border border-[#262626] rounded-xl p-5 space-y-4 h-fit lg:sticky lg:top-6">
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

        {perfil?.pode_bonificar && (
          <div>
            <label className={label}>Bônus na comissão (R$)</label>
            <input className={campo} type="number" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="opcional" />
            <p className="text-[10px] text-gray-600 mt-1">Some à comissão · teto: comissão + bônus ≤ entrada.</p>
          </div>
        )}

        <button
          onClick={() => simular(false)}
          disabled={carregando}
          className="w-full bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2.5 rounded-lg"
        >
          {carregando ? 'Calculando…' : 'Simular'}
        </button>

        {erro && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{erro}</p>
        )}
      </div>

      {/* ---- Resultados (empilham, mais recente no topo) ---- */}
      <div className="space-y-4">
        {confirmacao && (
          <div className="bg-[#141414] border border-yellow-500/40 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-yellow-400 text-xl">⚠️</span>
              <h2 className="font-display text-white text-base">Lote não está disponível</h2>
            </div>
            <p className="text-sm text-gray-300">{confirmacao.mensagem}</p>
            <div className="flex gap-3">
              <button
                onClick={() => simular(true)}
                disabled={carregando}
                className="flex-1 bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2 rounded-lg"
              >
                {carregando ? 'Calculando…' : 'Simular mesmo assim'}
              </button>
              <button
                onClick={() => setConfirmacao(null)}
                className="flex-1 border border-[#333] text-gray-300 hover:text-white py-2 rounded-lg"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {resultados.length === 0 && !confirmacao && (
          <div className="bg-[#141414] border border-dashed border-[#2a2a2a] rounded-xl p-8 text-center text-gray-500 text-sm min-h-[200px] flex items-center justify-center">
            Preencha os dados e clique em <span className="text-gray-300 mx-1">Simular</span> para ver a proposta.
          </div>
        )}

        {resultados.map((r, i) => (
          <CardSimulacao key={resultados.length - i} r={r} />
        ))}
      </div>
    </div>
  )
}
