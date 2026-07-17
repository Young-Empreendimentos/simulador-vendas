import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'
import Contrato from './Contrato'
import { EMPREENDIMENTOS } from './empreendimentos'

// Reforços por DATA (como o bot): o financiamento começa HOJE; o "mês" do reforço
// é a diferença em meses entre a data informada e hoje. Datas ISO (yyyy-mm-dd).
// Lista editável (cada linha = uma data + valor), no mesmo espírito das parcelas.
type Reforco = { id: string; data: string; valor: number }

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
const isoDe = (base: Date) =>
  `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`
// soma meses SEM estourar o dia: 31/jan + 1 mês = 28/fev (e não 03/mar), pra não
// pular/duplicar meses quando a frequência é curta e a data cai em fim de mês.
function somaMeses(y: number, mIndex0: number, dia: number, n: number): Date {
  const alvo = new Date(y, mIndex0 + n, 1)
  const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate()
  alvo.setDate(Math.min(dia, ultimoDia))
  return alvo
}
function addMesesISO(iso: string, n: number): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return isoDe(somaMeses(y, m - 1, d, n))
}
function hojeMaisMesesISO(n: number): string {
  const d = new Date()
  return isoDe(somaMeses(d.getFullYear(), d.getMonth(), d.getDate(), n))
}

// Série recorrente: a partir de inicioISO, a cada `freq` meses, enquanto o mês
// (em relação a hoje) for >= 1 e <= ateMes (padrão: a última parcela).
function serieDatas(inicioISO: string, freq: number, ateMes: number): string[] {
  const out: string[] = []
  if (!inicioISO || freq <= 0 || ateMes < 1) return out
  for (let k = 0; k < 600; k++) {
    const iso = addMesesISO(inicioISO, k * freq)
    const m = mesesDeHoje(iso)
    if (m > ateMes) break
    if (m >= 1) out.push(iso)
  }
  return out
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

// Número que anima de 0 até o valor (efeito Pingo Lead) quando o card aparece.
function CountUp({ value, className }: { value: number; className?: string }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const dur = 900, t0 = performance.now()
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      setV(value * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span className={className}>{brl(v)}</span>
}

// Dropdown próprio (o <select> nativo abre uma lista branca do sistema que não dá
// pra estilizar). Tema navy, fecha ao clicar fora e navega com teclado.
type Opcao = { value: string; label: string }
function Dropdown({
  value, onChange, options, placeholder, className, ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: Opcao[]
  placeholder?: string
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sel = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (open) setHi(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const escolher = (i: number) => {
    const o = options[i]
    if (o) { onChange(o.value); setOpen(false) }
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault(); setOpen(true); return
    }
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); escolher(hi) }
  }

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        className="w-full flex items-center justify-between gap-2 bg-[#0b111b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-left hover:border-white/20 focus:border-[#fe5009] focus:outline-none transition-colors"
      >
        <span className={`truncate ${sel ? 'text-white' : 'text-gray-500'}`}>{sel ? sel.label : (placeholder ?? 'Selecione…')}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-40 left-0 mt-1.5 w-full min-w-max max-h-64 overflow-auto rounded-xl border border-white/[0.1] bg-[#0f1520] shadow-2xl shadow-black/60 p-1 pop-in"
        >
          {options.map((o, i) => {
            const ativo = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={ativo}
                onMouseEnter={() => setHi(i)}
                onClick={() => escolher(i)}
                className={`w-full text-left rounded-lg px-2.5 py-1.5 text-sm flex items-center justify-between gap-3 transition-colors ${
                  hi === i ? 'bg-white/[0.07]' : ''
                } ${ativo ? 'text-[#fe5009]' : 'text-gray-200'}`}
              >
                <span className="truncate">{o.label}</span>
                {ativo && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m5 12 5 5L20 7" /></svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Toggle estilo switch — mesma semântica de um checkbox controlado.
function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-[#0b111b] border border-white/[0.07] rounded-xl hover:border-white/20 transition-colors"
    >
      <span className="text-sm text-gray-200">
        {label}
        {hint && <span className="text-gray-600 text-xs ml-1.5">{hint}</span>}
      </span>
      <span className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${on ? 'bg-[#fe5009]' : 'bg-[#2a3342]'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </button>
  )
}

// Card de uma simulação (com a comissão escondida atrás do olhinho) — estilo Pingo Lead.
function CardSimulacao({ r, onGerarContrato }: { r: Resultado; onGerarContrato: () => void }) {
  const [verComissao, setVerComissao] = useState(false)
  const [verReforcos, setVerReforcos] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id) }, [])
  const temReforcos = r.reforcos.length > 0
  const lbl = 'text-[10px] uppercase tracking-wider text-gray-500'
  return (
    <div className={`bg-[#0f1520] border border-white/[0.08] rounded-2xl p-5 space-y-4 transition-all duration-500 ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-white text-base">{r.empreendimento} · Lote {r.num_lote}</h2>
        {r.promocional && (
          <span className="text-[10px] uppercase tracking-wide text-[#00bcbc] border border-[#00bcbc]/40 rounded px-1.5 py-0.5">Promoção</span>
        )}
        {r.autonomia_aplicada && (
          <span className="text-[10px] uppercase tracking-wide text-[#004ebf] border border-[#004ebf]/40 rounded px-1.5 py-0.5">Autonomia</span>
        )}
      </div>

      <div className="flex items-end justify-between">
        <div>
          <p className={lbl}>Parcela mensal</p>
          <CountUp value={r.resumo.parcela_mensal} className="font-display text-4xl leading-none tracking-tight text-[#fe5009]" />
        </div>
        <p className="text-xs text-gray-500">em {r.resumo.prazo_meses}x</p>
      </div>

      {!r.disponivel && r.status_lote && (
        <p className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
          ⚠️ Atenção: este lote está como <strong>{r.status_lote}</strong> no Sienge — confirme a disponibilidade antes de prosseguir.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-[#131b28] rounded-xl p-3">
          <p className={lbl}>Entrada</p>
          <CountUp value={r.resumo.entrada} className="block mt-1 text-base font-semibold text-gray-100" />
        </div>
        <div className="bg-[#131b28] rounded-xl p-3">
          <p className={lbl}>Registro <span className="normal-case tracking-normal text-gray-600">(ITBI+Cartório)</span></p>
          <CountUp value={r.resumo.itbi + r.resumo.cartorio} className="block mt-1 text-base font-semibold text-gray-100" />
        </div>
      </div>

      {temReforcos && (
        <div className="bg-[#131b28] rounded-xl">
          <button onClick={() => setVerReforcos((v) => !v)} aria-expanded={verReforcos} className="w-full flex items-center justify-between p-3 text-left">
            <span className={lbl}>Reforços</span>
            <span className="text-gray-100 flex items-center gap-1.5 text-sm">
              {r.reforcos.length}× · {brl(r.resumo.total_reforcos)}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-500 transition-transform ${verReforcos ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
            </span>
          </button>
          <div className={`overflow-hidden transition-all duration-300 ${verReforcos ? 'max-h-60' : 'max-h-0'}`}>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] px-3 pb-3 max-h-44 overflow-y-auto">
              {r.reforcos.map((x, i) => (
                <li key={i} className="flex items-center justify-between gap-2 tabular-nums whitespace-nowrap">
                  <span className="text-gray-500">{x.data_str || `Mês ${x.mes}`}</span>
                  <span className="text-gray-300">{brl(Number(x.valor))}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between bg-[#131b28] border border-white/[0.08] rounded-xl px-4 py-3">
        <span className="text-sm text-gray-300">Valor total do financiamento</span>
        <CountUp value={r.resumo.total_pago} className="font-display text-2xl tracking-tight text-[#26e0a3]" />
      </div>

      {r.promo_descricao && <p className="text-xs text-[#00bcbc]">{r.promo_descricao}</p>}

      {/* Comissão (interna) — abre/fecha com transição pelo olhinho */}
      <div className={`overflow-hidden transition-all duration-300 ${verComissao ? 'max-h-48' : 'max-h-0'}`}>
        <div className="rounded-xl border border-white/[0.08] bg-[#131b28] p-3 text-sm space-y-1">
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
            <div className="flex justify-between border-t border-white/[0.08] mt-1 pt-1">
              <span className="text-gray-300">Total</span>
              <span className="text-[#fe5009]">{brl(r.interno.comissao_total)}</span>
            </div>
          )}
          <p className="text-[10px] text-gray-600 pt-1">Informação interna — não faz parte da proposta ao cliente.</p>
        </div>
      </div>

      <div className="border-t border-white/[0.08] pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setVerComissao((v) => !v)}
            title={verComissao ? 'ocultar comissão' : 'ver comissão'}
            aria-label={verComissao ? 'ocultar comissão' : 'ver comissão'}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <Olho aberto={verComissao} />
          </button>
          <button
            onClick={onGerarContrato}
            className="text-sm text-[#fe5009] hover:text-orange-400 font-medium whitespace-nowrap transition-colors"
          >
            Gerar contrato →
          </button>
        </div>
        <p className="text-[10px] text-gray-600">Simulação sem valor contratual — sujeita a conferência.</p>
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
  const [reforcos, setReforcos] = useState<Reforco[]>([])
  const [reforcosManual, setReforcosManual] = useState(false) // usuário editou a lista à mão?
  const [gValor, setGValor] = useState('')                    // gerador: valor de cada reforço
  const [gFreq, setGFreq] = useState('12')                    // '12'|'6'|'3'|'custom'
  const [gFreqN, setGFreqN] = useState('')                    // "a cada N meses"
  const [gData, setGData] = useState('')                      // 1ª data (opcional)
  const [reforcosAberto, setReforcosAberto] = useState(false)
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

  // Empreendimentos liberados pro usuário (vazio no perfil = todos).
  const empPermitidos = useMemo(() => {
    const p = perfil?.empreendimentos ?? []
    return p.length ? EMPREENDIMENTOS.filter((e) => p.includes(e)) : EMPREENDIMENTOS
  }, [perfil])
  // Se só tem 1, nem mostra o seletor — puxa direto.
  const empUnico = empPermitidos.length === 1 ? empPermitidos[0] : null
  useEffect(() => {
    if (empUnico && empreendimento !== empUnico) setEmpreendimento(empUnico)
  }, [empUnico]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reforços: a lista editável é a fonte única (resumo + payload).
  const prazoN = Number(prazo) || 0
  const LIMITE = limiteReforco(empreendimento)
  const teto = prazoN ? Math.min(prazoN + 6, LIMITE) : LIMITE // limite p/ QUALQUER reforço (até 6 meses após o fim)
  const fimContrato = Math.min(prazoN, teto)                  // auto-geração para na última parcela (0 se sem prazo)
  const gFreqMeses = gFreq === 'custom' ? (Number(gFreqN) || 0) : Number(gFreq)
  // mapeia a lista editável -> payload {mes,valor,data_str}: só linhas válidas,
  // SOMANDO reforços que caem no mesmo mês (o backend trata por mês) e ordenado.
  const listaReforcos = useMemo(() => {
    const mapa = new Map<number, { mes: number; valor: number; data_str: string }>()
    for (const x of reforcos) {
      const mes = mesesDeHoje(x.data)
      if (!x.data || !(x.valor > 0) || mes < 1 || mes > teto) continue
      const prev = mapa.get(mes)
      mapa.set(mes, { mes, valor: (prev?.valor || 0) + x.valor, data_str: prev?.data_str || isoParaBR(x.data) })
    }
    return [...mapa.values()].sort((a, b) => a.mes - b.mes)
  }, [reforcos, teto])
  const qtd = listaReforcos.length
  const totalReforcos = listaReforcos.reduce((s, x) => s + x.valor, 0)
  // linhas com data preenchida que NÃO entram no cálculo (fora do prazo ou sem valor)
  const excluidas = reforcos.filter((x) => !!x.data && !(mesesDeHoje(x.data) >= 1 && mesesDeHoje(x.data) <= teto && x.valor > 0)).length

  // Se trocar de empreendimento e perder o direito, zera a autonomia.
  useEffect(() => {
    if (!podeAutonomia && precoCustomizado) {
      setPrecoCustomizado(false)
      setValorCustom('')
    }
  }, [podeAutonomia, precoCustomizado])

  // Auto-geração: enquanto o usuário não editar à mão, a lista segue o gerador + prazo,
  // preenchendo automaticamente até a última parcela.
  useEffect(() => {
    if (reforcosManual) return
    const valor = parseBRL(gValor)
    if (valor <= 0 || gFreqMeses <= 0 || fimContrato < 1) { setReforcos([]); return }
    const inicio = gData || hojeMaisMesesISO(gFreqMeses) // 1ª data padrão = hoje + frequência
    const itens = serieDatas(inicio, gFreqMeses, fimContrato).map((data, i) => ({ id: `auto-${i}`, data, valor }))
    setReforcos(itens)
  }, [gValor, gFreqMeses, gData, fimContrato, reforcosManual])

  function editReforco(id: string, patch: Partial<Reforco>) {
    setReforcosManual(true)
    setReforcos((rs) => rs.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }
  function addReforco() {
    setReforcosManual(true)
    const ultima = reforcos.length ? reforcos[reforcos.length - 1].data : ''
    const prox = ultima ? addMesesISO(ultima, gFreqMeses > 0 ? gFreqMeses : 1) : (gData || hojeMaisMesesISO(1))
    setReforcos((rs) => [...rs, { id: crypto.randomUUID(), data: prox, valor: parseBRL(gValor) || 0 }])
  }
  function delReforco(id: string) {
    setReforcosManual(true)
    setReforcos((rs) => rs.filter((x) => x.id !== id))
  }
  function regerar() {
    setReforcosManual(false) // volta a seguir o gerador; o efeito refaz a lista
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
    body.reforcos = listaReforcos.map(({ mes, valor, data_str }) => ({ mes, valor, data_str }))

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
    'w-full bg-[#0b111b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none transition-colors'
  const label = 'block text-[11px] font-medium text-gray-400 mb-1'

  return (
    <>
      <div className="max-w-6xl mx-auto lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-4 lg:items-start space-y-4 lg:space-y-0">

        {/* ================= COLUNA ESQUERDA — formulário ================= */}
        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="bg-[#0f1520] border border-white/[0.08] rounded-2xl p-4 space-y-3 shadow-xl shadow-black/20">
            <div className="flex items-center gap-2 pb-0.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fe5009" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" /><line x1="8" y1="7" x2="16" y2="7" /><line x1="8" y1="11" x2="16" y2="11" /><line x1="8" y1="15" x2="13" y2="15" /></svg>
              <h2 className="font-display text-white text-sm">Nova simulação</h2>
            </div>

            {/* Campos principais */}
            <div>
              <label className={label}>Empreendimento</label>
              {empUnico ? (
                <div className="w-full flex items-center gap-2 bg-[#0b111b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fe5009" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></svg>
                  {empUnico}
                </div>
              ) : (
                <Dropdown
                  ariaLabel="Empreendimento"
                  value={empreendimento}
                  onChange={setEmpreendimento}
                  placeholder="Selecione…"
                  options={empPermitidos.map((e) => ({ value: e, label: e }))}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Lote</label>
                <input className={campo} value={numLote} onChange={(e) => setNumLote(e.target.value)} placeholder="nº" />
              </div>
              <div>
                <label className={label}>Prazo</label>
                <input className={campo} type="number" value={prazo} onChange={(e) => setPrazo(e.target.value)} placeholder="parcelas" />
              </div>
            </div>
            <div>
              <label className={label}>Entrada</label>
              <input className={campo} type="number" value={entrada} onChange={(e) => setEntrada(e.target.value)} placeholder="R$" />
            </div>

            {/* Condições */}
            <div className="flex items-center gap-2 pt-1">
              <span className="h-px flex-1 bg-white/[0.08]" />
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Condições</span>
              <span className="h-px flex-1 bg-white/[0.08]" />
            </div>

            <Toggle on={promocional} onChange={setPromocional} label="Promoção" />
            {podeAutonomia && (
              <>
                <Toggle on={precoCustomizado} onChange={setPrecoCustomizado} label="Autonomia" hint="(preço custom.)" />
                {precoCustomizado && (
                  <input className={campo} type="number" value={valorCustom} onChange={(e) => setValorCustom(e.target.value)} placeholder="preço à vista R$" />
                )}
              </>
            )}
            {perfil?.pode_bonificar && (
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-[#0b111b] border border-white/[0.07] rounded-xl">
                <span className="text-sm text-gray-200">Bônus</span>
                <input className="bg-transparent text-right text-sm text-white w-28 focus:outline-none placeholder:text-gray-600" type="number" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="R$ 0" />
              </div>
            )}

            {/* Reforços — seção própria colapsável */}
            <div className="bg-[#0b111b] border border-white/[0.07] rounded-xl">
              <button type="button" onClick={() => setReforcosAberto((v) => !v)} aria-expanded={reforcosAberto} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left">
                <span className="text-sm text-gray-200">Reforços</span>
                <span className="flex items-center gap-1.5 text-xs">
                  {qtd > 0 ? <span className="text-[#fe5009]">{qtd} · {brl(totalReforcos)}</span> : <span className="text-gray-600">opcional</span>}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-500 transition-transform ${reforcosAberto ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
                </span>
              </button>
              {reforcosAberto && (
                <div className="px-3 pb-3 pt-3 border-t border-white/[0.06] space-y-3">
                  {prazoN < 1 ? (
                    <p className="text-xs text-gray-500">Defina o <span className="text-gray-300">prazo</span> para gerar os reforços.</p>
                  ) : (
                    <>
                      {/* Gerador: valor + frequência (+ 1ª data). Preenche a lista até a última parcela. */}
                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className={label}>Valor de cada</label>
                          <input className={campo} type="text" inputMode="numeric" value={gValor} onChange={(e) => setGValor(e.target.value)} placeholder="ex: 5.000" />
                        </div>
                        <div>
                          <label className={label}>Frequência</label>
                          <Dropdown
                            ariaLabel="Frequência dos reforços"
                            value={gFreq}
                            onChange={setGFreq}
                            options={[
                              { value: '12', label: 'Anual' },
                              { value: '6', label: 'Semestral' },
                              { value: '3', label: 'Trimestral' },
                              { value: '1', label: 'Mensal' },
                              { value: 'custom', label: 'A cada N meses…' },
                            ]}
                          />
                        </div>
                      </div>
                      {gFreq === 'custom' && (
                        <div>
                          <label className={label}>A cada quantos meses</label>
                          <input className={campo} type="number" value={gFreqN} onChange={(e) => setGFreqN(e.target.value)} placeholder="ex: 4" />
                        </div>
                      )}
                      <div>
                        <label className={label}>1ª data <span className="text-gray-600">(opcional)</span></label>
                        <input className={campo} type="date" value={gData} onChange={(e) => setGData(e.target.value)} />
                      </div>
                      {reforcosManual && parseBRL(gValor) > 0 && gFreqMeses > 0 && (
                        <button type="button" onClick={regerar} className="text-xs text-gray-400 hover:text-[#fe5009] underline underline-offset-2 whitespace-nowrap" title="Descarta as edições e regenera a série a partir do valor e da frequência acima">↺ Regerar até o fim</button>
                      )}

                      <p className="text-[11px] text-gray-600">
                        Preenchido automaticamente até a <span className="text-gray-400">última parcela (mês {prazoN})</span>. Edite as datas e os valores como quiser — dá pra marcar até 6 meses depois do fim (mês {teto}).
                      </p>

                      {/* Lista editável — no mesmo espírito das parcelas */}
                      {reforcos.length > 0 ? (
                        <div className="rounded-lg border border-[#262626] overflow-hidden">
                          <div className="grid grid-cols-[1fr_1fr_auto] gap-px bg-[#262626] text-[10px] text-gray-500 uppercase tracking-wide">
                            <span className="bg-[#0d0d0d] px-2.5 py-1.5">Data</span>
                            <span className="bg-[#0d0d0d] px-2.5 py-1.5">Valor</span>
                            <span className="bg-[#0d0d0d] px-2 py-1.5 w-8" />
                          </div>
                          <div className="divide-y divide-[#1f1f1f] max-h-[22rem] overflow-y-auto">
                            {reforcos.map((x) => {
                              const m = mesesDeHoje(x.data)
                              const dataFora = !!x.data && (m < 1 || m > teto)
                              const valorFalta = !!x.data && !(x.valor > 0)
                              return (
                                <div key={x.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5 px-1.5 py-1.5">
                                  <input className={campo + ' px-2' + (dataFora ? ' border-red-500/60' : '')} type="date" value={x.data} onChange={(e) => editReforco(x.id, { data: e.target.value })} title={dataFora ? `Fora do intervalo permitido (mês 1 a ${teto}).` : ''} />
                                  <input className={campo + ' px-2' + (valorFalta ? ' border-red-500/60' : '')} type="number" value={x.valor || ''} onChange={(e) => editReforco(x.id, { valor: Number(e.target.value) || 0 })} placeholder="R$" title={valorFalta ? 'Informe um valor para este reforço entrar no cálculo.' : ''} />
                                  <button type="button" aria-label="Remover reforço" onClick={() => delReforco(x.id)} className="text-gray-600 hover:text-red-400 w-8">✕</button>
                                </div>
                              )
                            })}
                          </div>
                          <div className="px-3 py-2 bg-[#0d0d0d] border-t border-[#262626] space-y-1">
                            <div className="flex items-center justify-between">
                              <button type="button" onClick={addReforco} className="text-xs text-[#fe5009] hover:text-orange-400 font-medium">+ adicionar reforço</button>
                              <span className="text-xs text-gray-400">{qtd} {qtd === 1 ? 'reforço' : 'reforços'} · {brl(totalReforcos)}</span>
                            </div>
                            {excluidas > 0 && (
                              <p className="text-[11px] text-yellow-500/80">{excluidas} {excluidas === 1 ? 'linha não entra' : 'linhas não entram'} no cálculo (data fora do prazo ou valor vazio).</p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <p className="text-xs text-gray-600">Informe o valor e a frequência acima para gerar os reforços.</p>
                          <button type="button" onClick={addReforco} className="text-xs text-[#fe5009] hover:text-orange-400 font-medium whitespace-nowrap">+ manual</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Simular */}
            <button
              onClick={() => simular(false)}
              disabled={carregando}
              className="btn-shine w-full inline-flex items-center justify-center gap-2 bg-gradient-to-b from-[#ff6a25] to-[#fe5009] hover:from-[#ff7a3a] hover:to-[#ff5a15] text-white font-semibold px-6 py-2.5 rounded-xl shadow-lg shadow-[#fe5009]/25 hover:shadow-[#fe5009]/40 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] disabled:opacity-60 disabled:translate-y-0 disabled:cursor-wait transition-all duration-200"
            >
              {carregando ? (
                <>
                  <svg className="animate-spin-slow" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Simulando…
                </>
              ) : (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></svg>
                  Simular
                </>
              )}
            </button>
          </div>

          {erro && (
            <div className="pop-in text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              {erro}
              {erroPromo && promocional && (
                <button onClick={() => simular(false, true)} className="mt-2 block font-medium text-[#fe5009] hover:underline">
                  Simular sem promoção →
                </button>
              )}
            </div>
          )}
        </div>

        {/* ================= COLUNA DIREITA — proposta ================= */}
        <div className="space-y-4">
          {confirmacao && (
            <div className="pop-in bg-[#0f1520] border border-yellow-500/40 rounded-2xl p-5 space-y-4 shadow-xl shadow-black/20">
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

          {resultados.length === 0 && !confirmacao && (
            <div className="pop-in bg-[#0f1520] border border-dashed border-white/[0.12] rounded-2xl p-8 text-center text-gray-500 text-sm min-h-[10rem] flex items-center justify-center">
              <span>Preencha os dados e clique em <span className="text-gray-300 mx-1">Simular</span> para ver a proposta.</span>
            </div>
          )}

          {resultados.length > 0 && (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))] items-start">
              {resultados.map((r, i) => (
                <CardSimulacao key={resultados.length - i} r={r} onGerarContrato={() => setContratoSim(r)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {contratoSim && (
        <Contrato sim={contratoSim} onClose={() => setContratoSim(null)} />
      )}
    </>
  )
}
