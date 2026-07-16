import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'
import Contrato from './Contrato'

// Nomes exatos como estão em comercial_tabela_precos (a função normaliza no servidor).
const EMPREENDIMENTOS = [
  'Algarve', 'Aurora', 'Erico Verissimo', 'Ilha dos Açores',
  'Montecarlo', 'Morada da Coxilha', 'Parque Lorena 2',
]

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
              <li key={i}>{x.data_str || `Mês ${x.mes}`}: {brl(Number(x.valor))}</li>
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

  // Reforços: a lista editável é a fonte única (resumo + payload).
  const prazoN = Number(prazo) || 0
  const LIMITE = limiteReforco(empreendimento)
  const teto = prazoN ? Math.min(prazoN + 6, LIMITE) : LIMITE // limite p/ QUALQUER reforço (até 6 meses após o fim)
  const fimContrato = Math.min(prazoN, teto)                  // auto-geração para na última parcela (0 se sem prazo)
  const gFreqMeses = gFreq === 'custom' ? (Number(gFreqN) || 0) : Number(gFreq)
  // mapeia a lista editável -> payload {mes,valor,data_str}, só linhas válidas, ordenado
  const listaReforcos = useMemo(
    () => reforcos
      .map((x) => ({ id: x.id, mes: mesesDeHoje(x.data), valor: x.valor, data_str: isoParaBR(x.data) }))
      .filter((x) => !!x.data_str && x.valor > 0 && x.mes >= 1 && x.mes <= teto)
      .sort((a, b) => a.mes - b.mes),
    [reforcos, teto],
  )
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
            {prazoN < 1 ? (
              <p className="text-xs text-gray-500">Defina o <span className="text-gray-300">prazo</span> para gerar os reforços.</p>
            ) : (
              <>
                {/* Gerador: valor + frequência (+ 1ª data). Preenche a lista até a última parcela. */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-32">
                    <label className={label}>Valor de cada</label>
                    <input className={campo} type="text" inputMode="numeric" value={gValor} onChange={(e) => setGValor(e.target.value)} placeholder="ex: 5.000" />
                  </div>
                  <div className="w-36">
                    <label className={label}>Frequência</label>
                    <select className={campo} value={gFreq} onChange={(e) => setGFreq(e.target.value)}>
                      <option value="12">Anual</option>
                      <option value="6">Semestral</option>
                      <option value="3">Trimestral</option>
                      <option value="1">Mensal</option>
                      <option value="custom">A cada N meses…</option>
                    </select>
                  </div>
                  {gFreq === 'custom' && (
                    <div className="w-24">
                      <label className={label}>A cada (meses)</label>
                      <input className={campo} type="number" value={gFreqN} onChange={(e) => setGFreqN(e.target.value)} placeholder="ex: 4" />
                    </div>
                  )}
                  <div className="w-40">
                    <label className={label}>1ª data <span className="text-gray-600">(opcional)</span></label>
                    <input className={campo} type="date" value={gData} onChange={(e) => setGData(e.target.value)} />
                  </div>
                  {reforcosManual && parseBRL(gValor) > 0 && gFreqMeses > 0 && (
                    <button type="button" onClick={regerar} className="self-end text-xs text-gray-400 hover:text-[#fe5009] underline underline-offset-2 pb-1.5 whitespace-nowrap" title="Descarta as edições e regenera a série a partir do valor e da frequência acima">↺ Regerar até o fim</button>
                  )}
                </div>

                <p className="text-[11px] text-gray-600">
                  Preenchido automaticamente até a <span className="text-gray-400">última parcela (mês {prazoN})</span>. Edite as datas e os valores como quiser — dá pra marcar até 6 meses depois do fim (mês {teto}).
                </p>

                {/* Lista editável — no mesmo espírito das parcelas */}
                {reforcos.length > 0 ? (
                  <div className="rounded-lg border border-[#262626] overflow-hidden">
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-px bg-[#262626] text-[10px] text-gray-500 uppercase tracking-wide">
                      <span className="bg-[#0d0d0d] px-3 py-1.5">Data</span>
                      <span className="bg-[#0d0d0d] px-3 py-1.5">Valor</span>
                      <span className="bg-[#0d0d0d] px-3 py-1.5 w-9" />
                    </div>
                    <div className="divide-y divide-[#1f1f1f] max-h-52 overflow-y-auto">
                      {reforcos.map((x) => {
                        const m = mesesDeHoje(x.data)
                        const dataFora = !!x.data && (m < 1 || m > teto)
                        const valorFalta = !!x.data && !(x.valor > 0)
                        return (
                          <div key={x.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 px-2 py-1.5">
                            <input className={campo + (dataFora ? ' border-red-500/60' : '')} type="date" value={x.data} onChange={(e) => editReforco(x.id, { data: e.target.value })} title={dataFora ? `Fora do intervalo permitido (mês 1 a ${teto}).` : ''} />
                            <input className={campo + (valorFalta ? ' border-red-500/60' : '')} type="number" value={x.valor || ''} onChange={(e) => editReforco(x.id, { valor: Number(e.target.value) || 0 })} placeholder="R$" title={valorFalta ? 'Informe um valor para este reforço entrar no cálculo.' : ''} />
                            <button type="button" aria-label="Remover reforço" onClick={() => delReforco(x.id)} className="text-gray-600 hover:text-red-400 w-9">✕</button>
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
                    <button type="button" onClick={addReforco} className="text-xs text-[#fe5009] hover:text-orange-400 font-medium whitespace-nowrap">+ adicionar manualmente</button>
                  </div>
                )}
              </>
            )}
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
