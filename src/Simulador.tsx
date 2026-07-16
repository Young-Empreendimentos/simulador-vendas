import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'
import Contrato from './Contrato'

// Nomes exatos como estão em comercial_tabela_precos (a função normaliza no servidor).
const EMPREENDIMENTOS = [
  'Algarve', 'Aurora', 'Erico Verissimo', 'Ilha dos Açores',
  'Montecarlo', 'Morada da Coxilha', 'Parque Lorena 2', 'Parque Lorena Itaqui',
]

// Reforços por DATA (como o bot): o financiamento começa HOJE; o "mês" do reforço
// é a diferença em meses entre a data informada e hoje. Datas ISO (yyyy-mm-dd).
type Regra =
  | { id: string; tipo: 'avulso'; data: string; valor: number }
  | { id: string; tipo: 'recorrente'; freq: number; valor: number; dataInicio: string; ate: 'fim' | string }

// pt-BR: aceita "5.000", "5000", "5.000,50"
const parseBRL = (s: string) => {
  const t = String(s).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : 0
}
const normEmp = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
// espelha o limite do backend (default 180)
function limiteReforco(emp: string) {
  const e = normEmp(emp)
  if (e.includes('aurora')) return 240
  if (e.includes('morada da coxilha')) return 360
  return 180
}
const rotuloFreq = (f: number) =>
  f === 3 ? 'trimestral' : f === 6 ? 'semestral' : f === 12 ? 'anual' : `a cada ${f} meses`

// ── datas ──
const isoParaBR = (iso: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}
// nº de meses da data em relação a hoje (financiamento começa hoje)
function mesesDeHoje(iso: string): number {
  if (!iso) return 0
  const [y, m] = iso.split('-').map(Number)
  const hoje = new Date()
  return (y - hoje.getFullYear()) * 12 + (m - 1 - hoje.getMonth())
}
function addMesesISO(iso: string, n: number): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const base = new Date(y, m - 1 + n, d)
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`
}
function hojeMaisMesesISO(n: number): string {
  const d = new Date()
  const base = new Date(d.getFullYear(), d.getMonth() + n, d.getDate())
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`
}

// Expande as regras -> lista {mes,valor,data_str}[], merge por mês, clamp (mes>=1, <=teto).
function expandir(regras: Regra[], teto: number): { mes: number; valor: number; data_str: string }[] {
  const mapa = new Map<number, { valor: number; data_str: string }>()
  const add = (iso: string, valor: number) => {
    const mes = mesesDeHoje(iso)
    if (!(mes >= 1) || mes > teto || !(valor > 0)) return
    const prev = mapa.get(mes)
    mapa.set(mes, { valor: (prev?.valor || 0) + valor, data_str: isoParaBR(iso) })
  }
  for (const r of regras) {
    if (r.tipo === 'avulso') add(r.data, r.valor)
    else {
      if (r.freq <= 0 || !r.dataInicio) continue
      for (let k = 0; k < 600; k++) {
        const iso = addMesesISO(r.dataInicio, k * r.freq)
        if (mesesDeHoje(iso) > teto) break
        if (r.ate !== 'fim' && iso > r.ate) break
        add(iso, r.valor)
      }
    }
  }
  return [...mapa.entries()].sort((a, b) => a[0] - b[0]).map(([mes, v]) => ({ mes, valor: v.valor, data_str: v.data_str }))
}
function contaRegra(r: Regra, teto: number): number {
  if (r.tipo === 'avulso') { const m = mesesDeHoje(r.data); return m >= 1 && m <= teto ? 1 : 0 }
  if (r.freq <= 0 || !r.dataInicio) return 0
  let c = 0
  for (let k = 0; k < 600; k++) {
    const iso = addMesesISO(r.dataInicio, k * r.freq)
    const mes = mesesDeHoje(iso)
    if (mes > teto) break
    if (r.ate !== 'fim' && iso > r.ate) break
    if (mes >= 1) c++
  }
  return c
}

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
function CardSimulacao({ r, onGerarContrato }: { r: Resultado; onGerarContrato: () => void }) {
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
          <span className="text-gray-400">Custos de registro (ITBI + Cartório)</span>
          <span className="text-white">{brl(r.resumo.itbi + r.resumo.cartorio)}</span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5 bg-[#0d0d0d]">
          <span className="text-gray-200">Valor total do financiamento</span>
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
          title={verComissao ? 'ocultar comissão' : 'ver comissão'}
          aria-label={verComissao ? 'ocultar comissão' : 'ver comissão'}
          className="text-gray-400 hover:text-white"
        >
          <Olho aberto={verComissao} />
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

      <div className="flex items-center justify-between border-t border-[#262626] pt-3">
        <p className="text-[11px] text-gray-600">Simulação sem valor contratual — sujeita a conferência.</p>
        <button
          onClick={onGerarContrato}
          className="text-sm text-[#fe5009] hover:text-orange-400 font-medium whitespace-nowrap"
        >
          Gerar contrato →
        </button>
      </div>
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
  const [regras, setRegras] = useState<Regra[]>([])
  const [modo, setModo] = useState<'recorrente' | 'avulso'>('recorrente')
  const [fValor, setFValor] = useState('')
  const [fFreq, setFFreq] = useState('12')
  const [fFreqN, setFFreqN] = useState('')
  const [fDataInicio, setFDataInicio] = useState('')
  const [fAte, setFAte] = useState<'fim' | 'data'>('fim')
  const [fAteData, setFAteData] = useState('')
  const [fData, setFData] = useState('')
  const [reforcosAberto, setReforcosAberto] = useState(false)
  const valorRef = useRef<HTMLInputElement>(null)
  const [promocional, setPromocional] = useState(false)
  const [precoCustomizado, setPrecoCustomizado] = useState(false)
  const [valorCustom, setValorCustom] = useState('')
  const [bonus, setBonus] = useState('')

  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [erroPromo, setErroPromo] = useState(false)
  const [resultados, setResultados] = useState<Resultado[]>([])
  const [confirmacao, setConfirmacao] = useState<{ status_lote: string; mensagem: string } | null>(null)
  const [contratoSim, setContratoSim] = useState<Resultado | null>(null)

  const ehMontecarlo = empreendimento.toLowerCase() === 'montecarlo'
  const podeAutonomia = !!perfil?.pode_autonomia && ehMontecarlo

  // Reforços: regras -> lista achatada (fonte única p/ régua, resumo e payload)
  const prazoN = Number(prazo) || 0
  const LIMITE = limiteReforco(empreendimento)
  const teto = prazoN ? Math.min(prazoN + 6, LIMITE) : LIMITE
  const listaReforcos = useMemo(() => expandir(regras, teto), [regras, teto])
  const qtd = listaReforcos.length
  const totalReforcos = listaReforcos.reduce((s, x) => s + x.valor, 0)

  // Se trocar de empreendimento e perder o direito, zera a autonomia.
  useEffect(() => {
    if (!podeAutonomia && precoCustomizado) {
      setPrecoCustomizado(false)
      setValorCustom('')
    }
  }, [podeAutonomia, precoCustomizado])

  function addRegra() {
    const valor = parseBRL(fValor)
    if (valor <= 0) return
    const id = crypto.randomUUID()
    if (modo === 'avulso') {
      if (!fData || mesesDeHoje(fData) < 1) return
      setRegras((r) => [...r, { id, tipo: 'avulso', data: fData, valor }])
    } else {
      const freq = fFreq === 'custom' ? Number(fFreqN) || 0 : Number(fFreq)
      if (freq <= 0 || !fDataInicio) return
      const ate: 'fim' | string = fAte === 'fim' ? 'fim' : fAteData || 'fim'
      setRegras((r) => [...r, { id, tipo: 'recorrente', freq, valor, dataInicio: fDataInicio, ate }])
    }
    setFValor('')
    setFData('')
  }
  function delRegra(id: string) {
    setRegras((r) => r.filter((x) => x.id !== id))
  }
  function preset(kind: 'anual' | 'semestral' | 'unico') {
    if (kind === 'unico') setModo('avulso')
    else {
      const freq = kind === 'anual' ? 12 : 6
      setModo('recorrente')
      setFFreq(String(freq))
      setFDataInicio(hojeMaisMesesISO(freq)) // 1ª data padrão = hoje + frequência
      setFAte('fim')
    }
    requestAnimationFrame(() => valorRef.current?.focus())
  }

  async function simular(confirmarFlag = false, semPromo = false) {
    setErro(null)
    setErroPromo(false)
    if (semPromo) setPromocional(false)
    if (!confirmarFlag) setConfirmacao(null)
    if (!empreendimento) return setErro('Selecione o empreendimento.')
    if (!numLote.trim()) return setErro('Informe o número do lote.')

    const body: Record<string, unknown> = {
      empreendimento,
      num_lote: numLote.trim(),
      entrada: Number(entrada) || 0,
      promocional: semPromo ? false : promocional,
      preco_customizado: precoCustomizado,
      confirmar: confirmarFlag,
    }
    if (precoCustomizado) body.valor_lote = Number(valorCustom) || 0
    if (perfil?.pode_bonificar) body.bonus = Number(bonus) || 0
    body.prazo_meses = Number(prazo) || 0
    body.reforcos = listaReforcos

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
        setErroPromo(data.erro === 'PROMO_EXPIRADA' || data.erro === 'PROMO_NAO_ATIVA')
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
    'w-full bg-[#0d0d0d] border border-[#333] rounded-lg px-2.5 py-1.5 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none'
  const label = 'block text-[11px] font-medium text-gray-400 mb-1'

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* ---- Barra de simulação (horizontal) ---- */}
      <div className="bg-[#141414] border border-[#262626] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <div className="w-52">
            <label className={label}>Empreendimento</label>
            <select className={campo} value={empreendimento} onChange={(e) => setEmpreendimento(e.target.value)}>
              <option value="">Selecione…</option>
              {EMPREENDIMENTOS.map((e) => (<option key={e} value={e}>{e}</option>))}
            </select>
          </div>
          <div className="w-16">
            <label className={label}>Lote</label>
            <input className={campo} value={numLote} onChange={(e) => setNumLote(e.target.value)} placeholder="nº" />
          </div>
          <div className="w-28">
            <label className={label}>Entrada</label>
            <input className={campo} type="number" value={entrada} onChange={(e) => setEntrada(e.target.value)} placeholder="R$" />
          </div>
          <div className="w-20">
            <label className={label}>Prazo</label>
            <input className={campo} type="number" value={prazo} onChange={(e) => setPrazo(e.target.value)} placeholder="parc." />
          </div>

          <div className="w-px self-stretch bg-[#262626] mx-1" />

          {/* opções na mesma linha (alinhadas à base dos campos) */}
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 h-[34px] text-sm">
            <label className="flex items-center gap-2 text-gray-300 whitespace-nowrap">
              <input type="checkbox" checked={promocional} onChange={(e) => setPromocional(e.target.checked)} /> Promoção
            </label>
            {podeAutonomia && (
              <label className="flex items-center gap-2 text-gray-300 whitespace-nowrap">
                <input type="checkbox" checked={precoCustomizado} onChange={(e) => setPrecoCustomizado(e.target.checked)} /> Autonomia
              </label>
            )}
            {precoCustomizado && (
              <input className={campo + ' w-36'} type="number" value={valorCustom} onChange={(e) => setValorCustom(e.target.value)} placeholder="preço à vista R$" />
            )}
            {perfil?.pode_bonificar && (
              <label className="flex items-center gap-2 text-gray-300 whitespace-nowrap">
                Bônus <input className={campo + ' w-24'} type="number" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="R$" />
              </label>
            )}
            <button type="button" onClick={() => setReforcosAberto((v) => !v)} className="flex items-center gap-1.5 text-gray-300 hover:text-white whitespace-nowrap">
              Reforços
              {qtd > 0 && <span className="text-xs text-[#fe5009]">{qtd} · {brl(totalReforcos)}</span>}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${reforcosAberto ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </div>

          <button
            onClick={() => simular(false)}
            disabled={carregando}
            className="ml-auto self-end bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium px-6 py-1.5 rounded-lg"
          >
            {carregando ? '…' : 'Simular'}
          </button>
        </div>

        {/* painel de reforços (full width quando aberto) */}
        {reforcosAberto && (
          <div className="border-t border-[#262626] pt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500 mr-1">Atalhos:</span>
              {([['anual', 'Anual'], ['semestral', 'Semestral'], ['unico', 'Só um reforço']] as const).map(([k, t]) => (
                <button key={k} type="button" onClick={() => preset(k)} className="px-3 py-1 rounded-full border border-[#333] bg-[#0d0d0d] text-xs text-gray-300 hover:border-[#fe5009] hover:text-white transition">{t}</button>
              ))}
              <span className="text-[11px] text-gray-600">Datas futuras — o financiamento começa hoje.</span>
            </div>

            {prazoN > 0 ? (
              <div className="rounded-lg bg-[#0d0d0d] border border-[#262626] px-3 pt-4 pb-2">
                <div className="relative h-8">
                  <div className="absolute inset-x-0 top-3 h-[3px] bg-[#262626] rounded-full" />
                  {Array.from({ length: Math.floor(prazoN / 12) }, (_, i) => (i + 1) * 12).map((a) => (
                    <div key={a} className="absolute top-1 w-px h-4 bg-[#333]" style={{ left: `${(a / prazoN) * 100}%` }} />
                  ))}
                  {listaReforcos.map((x) => (
                    <div key={x.mes} title={`${x.data_str} · ${brl(x.valor)}`} className="absolute top-3 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-[#fe5009] ring-2 ring-[#0d0d0d]" style={{ left: `${Math.min(x.mes / prazoN, 1) * 100}%` }} />
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-gray-600 mt-1"><span>mês 1</span><span>{prazoN} meses</span></div>
              </div>
            ) : (
              <p className="text-xs text-gray-600">Defina o prazo para posicionar os reforços na linha do tempo.</p>
            )}

            {regras.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {regras.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-2 bg-[#1a1a1a] border border-[#333] rounded-full pl-3 pr-2 py-1 text-xs text-gray-200">
                    {r.tipo === 'avulso'
                      ? `${brl(r.valor)} · ${isoParaBR(r.data)}`
                      : `${brl(r.valor)} · ${rotuloFreq(r.freq)} · a partir de ${isoParaBR(r.dataInicio)} ${r.ate === 'fim' ? 'até o fim' : 'até ' + isoParaBR(r.ate)} (${contaRegra(r, teto)}x)`}
                    <button type="button" aria-label="Remover reforço" onClick={() => delRegra(r.id)} className="text-gray-500 hover:text-red-400">✕</button>
                  </span>
                ))}
              </div>
            )}

            {/* mini-form horizontal */}
            <div className="flex flex-wrap items-end gap-3 rounded-lg bg-[#0d0d0d] border border-[#262626] p-3">
              <div className="w-40">
                <label className={label}>Tipo</label>
                <div className="grid grid-cols-2 gap-1 bg-[#141414] p-1 rounded-lg">
                  {(['recorrente', 'avulso'] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setModo(m)} className={`text-xs py-1 rounded-md transition ${modo === m ? 'bg-[#fe5009] text-white' : 'text-gray-400 hover:text-white'}`}>{m === 'recorrente' ? 'Repetir' : 'Uma vez'}</button>
                  ))}
                </div>
              </div>
              <div className="w-32">
                <label className={label}>Valor (R$)</label>
                <input ref={valorRef} className={campo} type="text" inputMode="numeric" value={fValor} onChange={(e) => setFValor(e.target.value)} placeholder="ex: 5.000" />
              </div>
              {modo === 'avulso' ? (
                <div className="w-40">
                  <label className={label}>Data</label>
                  <input className={campo} type="date" value={fData} onChange={(e) => setFData(e.target.value)} />
                </div>
              ) : (
                <>
                  <div className="w-36">
                    <label className={label}>Frequência</label>
                    <select className={campo} value={fFreq} onChange={(e) => setFFreq(e.target.value)}>
                      <option value="12">Anual</option>
                      <option value="6">Semestral</option>
                      <option value="3">Trimestral</option>
                      <option value="custom">A cada N meses…</option>
                    </select>
                  </div>
                  {fFreq === 'custom' && (
                    <div className="w-28">
                      <label className={label}>A cada (meses)</label>
                      <input className={campo} type="number" value={fFreqN} onChange={(e) => setFFreqN(e.target.value)} placeholder="ex: 4" />
                    </div>
                  )}
                  <div className="w-40">
                    <label className={label}>Primeira data</label>
                    <input className={campo} type="date" value={fDataInicio} onChange={(e) => setFDataInicio(e.target.value)} />
                  </div>
                  <div className="w-56">
                    <label className={label}>Repetir até</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setFAte('fim')} className={`${campo} text-left ${fAte === 'fim' ? 'border-[#fe5009] text-white' : 'text-gray-400'}`}>o fim</button>
                      <input className={campo} type="date" value={fAteData} onFocus={() => setFAte('data')} onChange={(e) => { setFAte('data'); setFAteData(e.target.value) }} />
                    </div>
                  </div>
                </>
              )}
              <button type="button" onClick={addRegra} disabled={modo === 'recorrente' && fAte === 'fim' && !prazoN} className="bg-[#fe5009] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-1.5 transition">+ Adicionar</button>
            </div>
          </div>
        )}

        {erro && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {erro}
            {erroPromo && promocional && (
              <button onClick={() => simular(false, true)} className="mt-2 block font-medium text-[#fe5009] hover:underline">
                Simular sem promoção →
              </button>
            )}
          </div>
        )}
      </div>

      {/* ---- Confirmação ---- */}
      {confirmacao && (
        <div className="bg-[#141414] border border-yellow-500/40 rounded-xl p-5 space-y-4 max-w-xl">
          <div className="flex items-center gap-2">
            <span className="text-yellow-400 text-xl">⚠️</span>
            <span className="font-display text-white text-base">Lote não está disponível</span>
          </div>
          <p className="text-sm text-gray-300">{confirmacao.mensagem}</p>
          <div className="flex gap-3">
            <button onClick={() => simular(true)} disabled={carregando} className="flex-1 bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2 rounded-lg">
              {carregando ? 'Calculando…' : 'Simular mesmo assim'}
            </button>
            <button onClick={() => setConfirmacao(null)} className="flex-1 border border-[#333] text-gray-300 hover:text-white py-2 rounded-lg">Cancelar</button>
          </div>
        </div>
      )}

      {/* ---- Resultados (grade) ---- */}
      {resultados.length === 0 && !confirmacao && (
        <div className="bg-[#141414] border border-dashed border-[#2a2a2a] rounded-xl p-8 text-center text-gray-500 text-sm">
          Preencha os dados e clique em <span className="text-gray-300 mx-1">Simular</span> para ver a proposta.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 items-start">
        {resultados.map((r, i) => (
          <CardSimulacao key={resultados.length - i} r={r} onGerarContrato={() => setContratoSim(r)} />
        ))}
      </div>

      {contratoSim && (
        <Contrato sim={contratoSim} onClose={() => setContratoSim(null)} />
      )}
    </div>
  )
}
