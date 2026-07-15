import { useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './auth'

// Tipo mínimo da simulação escolhida (o que o contrato precisa)
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

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
// yyyy-mm-dd (input date) -> dd/mm/aaaa (contrato)
const brDate = (iso: string) => {
  if (!iso) return ''
  const [a, m, d] = iso.split('-')
  return a && m && d ? `${d}/${m}/${a}` : iso
}

// Parque Lorena Itaqui tem duas vendedoras (young/horizonte) → precisa escolher.
const ehAmbiguo = (emp: string) => emp.trim().toLowerCase() === 'parque lorena itaqui'

type Campos = Record<string, string>

export default function Contrato({ sim, onClose }: { sim: SimParaContrato; onClose: () => void }) {
  const { perfil } = useAuth()
  const ambiguo = useMemo(() => ehAmbiguo(sim.empreendimento), [sim.empreendimento])

  const [tipo, setTipo] = useState<'aprazo' | 'avista'>('aprazo')
  const [comprador1, setComprador1] = useState('')
  const [comprador2, setComprador2] = useState('')
  const [qualificacao, setQualificacao] = useState('')
  const [area, setArea] = useState('')
  const [matricula, setMatricula] = useState('')
  const [onus, setOnus] = useState('N')
  const [dataAssinatura, setDataAssinatura] = useState('')
  const [dataEntrada, setDataEntrada] = useState('')
  const [dataPrimVenc, setDataPrimVenc] = useState('')
  const [dadosBancoEmp, setDadosBancoEmp] = useState('')
  const [proprietario, setProprietario] = useState('young')

  const [reforcosData, setReforcosData] = useState<string[]>(() => sim.reforcos.map(() => ''))

  const [temCorretor, setTemCorretor] = useState(false)
  const [cor, setCor] = useState({
    nome: '', doc: '', creci: '', endereco: '', bairro: '', cidade: '', uf: '', cep: '', telefone: '', email: '', dados_bancarios: '',
  })
  const setCorField = (k: keyof typeof cor, v: string) => setCor((p) => ({ ...p, [k]: v }))
  const [bonus, setBonus] = useState('')

  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [campos, setCampos] = useState<Campos | null>(null)
  const [calc, setCalc] = useState<Record<string, string> | null>(null)

  async function preVisualizar() {
    setErro(null); setCampos(null); setCalc(null)
    if (!comprador1.trim()) return setErro('Informe o Comprador 1.')

    const body: Record<string, unknown> = {
      tipo_contrato: tipo,
      empreendimento: sim.empreendimento,
      num_lote: sim.num_lote,
      Lote: sim.num_lote,
      // financeiro (da simulação)
      valor_lote_av: sim.resumo.valor_lote_av,
      entrada_bruta: tipo === 'avista' ? sim.resumo.valor_lote_av : sim.resumo.entrada,
      parcela_mensal: sim.resumo.parcela_mensal,
      prazo_meses: sim.resumo.prazo_meses,
      itbi: sim.resumo.itbi,
      cartorio: sim.resumo.cartorio,
      reforcos: sim.reforcos.map((r, i) => ({ valor: Number(r.valor), data_str: brDate(reforcosData[i] || '') })),
      data_entrada: brDate(dataEntrada),
      data_primeiro_vencimento: brDate(dataPrimVenc),
      dados_bancarios_empresa: dadosBancoEmp,
      // imóvel / compradores
      Qualificacao_Clientes: qualificacao,
      Comprador1: comprador1,
      Comprador2: comprador2,
      Area: area,
      Matricula: matricula,
      Onus: onus,
      Data_Assinatura: brDate(dataAssinatura),
      // intermediação
      tem_corretor: temCorretor,
    }
    if (ambiguo) body.proprietario = proprietario
    if (temCorretor) {
      body.nome_corretor = cor.nome
      body.doc_corretor = cor.doc
      body.creci_corretor = cor.creci
      body.endereco_corretor = cor.endereco
      body.bairro_corretor = cor.bairro
      body.cidade_corretor = cor.cidade
      body.uf_corretor = cor.uf
      body.cep_corretor = cor.cep
      body.telefone_corretor = cor.telefone
      body.email_corretor = cor.email
      body.dados_bancarios_corretor = cor.dados_bancarios
      if (perfil?.pode_bonificar) body.bonus_comissao = Number(bonus) || 0
    }

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
      setCampos(data.campos as Campos)
      setCalc(data._calc as Record<string, string>)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao montar o contrato.')
    } finally {
      setCarregando(false)
    }
  }

  const campo = 'w-full bg-[#0d0d0d] border border-[#333] rounded-lg px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:border-[#fe5009] focus:outline-none'
  const label = 'block text-xs font-medium text-gray-400 mb-1'
  const secao = 'font-display text-white text-sm border-b border-[#262626] pb-1'

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto p-4 sm:p-8" onClick={onClose}>
      <div
        className="mx-auto max-w-3xl bg-[#141414] border border-[#262626] rounded-2xl p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-white text-lg">Gerar contrato</h2>
            <p className="text-sm text-gray-400">{sim.empreendimento} · Lote {sim.num_lote} · {tipo === 'avista' ? 'à vista' : 'à prazo'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* tipo */}
        <div className="flex rounded-lg border border-[#333] overflow-hidden text-sm w-64">
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

        {/* Imóvel */}
        <div className="space-y-3">
          <h3 className={secao}>Imóvel</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><label className={label}>Área</label><input className={campo} value={area} onChange={(e) => setArea(e.target.value)} placeholder="m²" /></div>
            <div><label className={label}>Matrícula</label><input className={campo} value={matricula} onChange={(e) => setMatricula(e.target.value)} /></div>
            <div><label className={label}>Ônus</label><input className={campo} value={onus} onChange={(e) => setOnus(e.target.value)} placeholder="N = Não há" /></div>
            <div><label className={label}>Data de assinatura</label><input type="date" className={campo} value={dataAssinatura} onChange={(e) => setDataAssinatura(e.target.value)} /></div>
          </div>
          {ambiguo && (
            <div className="w-64">
              <label className={label}>Vendedora (proprietário)</label>
              <select className={campo} value={proprietario} onChange={(e) => setProprietario(e.target.value)}>
                <option value="young">Young (ITY)</option>
                <option value="horizonte">Horizonte</option>
              </select>
            </div>
          )}
        </div>

        {/* Pagamento */}
        <div className="space-y-3">
          <h3 className={secao}>Pagamento</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Data da entrada</label><input type="date" className={campo} value={dataEntrada} onChange={(e) => setDataEntrada(e.target.value)} /></div>
            {tipo === 'aprazo' && (
              <div><label className={label}>1º vencimento (parcelas)</label><input type="date" className={campo} value={dataPrimVenc} onChange={(e) => setDataPrimVenc(e.target.value)} /></div>
            )}
          </div>
          <div>
            <label className={label}>Dados bancários da empresa (CREDORA)</label>
            <textarea className={campo + ' min-h-[56px]'} value={dadosBancoEmp} onChange={(e) => setDadosBancoEmp(e.target.value)} placeholder="banco, agência, conta, PIX…" />
          </div>
          {tipo === 'aprazo' && sim.reforcos.length > 0 && (
            <div>
              <label className={label}>Datas dos reforços</label>
              <div className="space-y-2">
                {sim.reforcos.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-400 w-40">Reforço (mês {r.mes}): {brl(Number(r.valor))}</span>
                    <input type="date" className={campo + ' max-w-[180px]'} value={reforcosData[i]} onChange={(e) => setReforcosData((p) => p.map((x, j) => (j === i ? e.target.value : x)))} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Intermediação */}
        <div className="space-y-3">
          <h3 className={secao}>Intermediação</h3>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={temCorretor} onChange={(e) => setTemCorretor(e.target.checked)} />
            Tem corretor / imobiliária externa (honorários de intermediação)
          </label>
          {temCorretor && (
            <div className="rounded-lg border border-[#333] p-3 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div><label className={label}>Nome / razão social</label><input className={campo} value={cor.nome} onChange={(e) => setCorField('nome', e.target.value)} /></div>
                <div><label className={label}>CPF/CNPJ</label><input className={campo} value={cor.doc} onChange={(e) => setCorField('doc', e.target.value)} /></div>
                <div><label className={label}>CRECI</label><input className={campo} value={cor.creci} onChange={(e) => setCorField('creci', e.target.value)} /></div>
                <div className="sm:col-span-2"><label className={label}>Endereço</label><input className={campo} value={cor.endereco} onChange={(e) => setCorField('endereco', e.target.value)} /></div>
                <div><label className={label}>Bairro</label><input className={campo} value={cor.bairro} onChange={(e) => setCorField('bairro', e.target.value)} /></div>
                <div><label className={label}>Cidade</label><input className={campo} value={cor.cidade} onChange={(e) => setCorField('cidade', e.target.value)} /></div>
                <div><label className={label}>UF</label><input className={campo} value={cor.uf} onChange={(e) => setCorField('uf', e.target.value)} /></div>
                <div><label className={label}>CEP</label><input className={campo} value={cor.cep} onChange={(e) => setCorField('cep', e.target.value)} /></div>
                <div><label className={label}>Telefone</label><input className={campo} value={cor.telefone} onChange={(e) => setCorField('telefone', e.target.value)} /></div>
                <div><label className={label}>E-mail</label><input className={campo} value={cor.email} onChange={(e) => setCorField('email', e.target.value)} /></div>
              </div>
              <div>
                <label className={label}>Dados bancários do corretor</label>
                <textarea className={campo + ' min-h-[48px]'} value={cor.dados_bancarios} onChange={(e) => setCorField('dados_bancarios', e.target.value)} />
              </div>
              {perfil?.pode_bonificar && (
                <div className="w-56">
                  <label className={label}>Bônus na comissão (R$)</label>
                  <input className={campo} type="number" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="opcional" />
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={preVisualizar}
          disabled={carregando}
          className="w-full bg-[#fe5009] hover:bg-orange-600 disabled:opacity-50 transition text-white font-medium py-2.5 rounded-lg"
        >
          {carregando ? 'Montando…' : 'Pré-visualizar contrato'}
        </button>
        {erro && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{erro}</p>}

        {/* Prévia */}
        {campos && (
          <div className="space-y-4 border-t border-[#262626] pt-4">
            <h3 className={secao}>Prévia do contrato</h3>
            {([
              ['3. Valor do Imóvel', campos.Valor_Imovel],
              ['4. Forma de Pagamento', campos.Forma_de_Pagamento],
              ['11. Honorários', campos.Honorarios],
              ['Qualificação da Vendedora', campos.Qualificacao_Vendedora],
              ['Final do contrato', campos.Final_Contrato],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <p className="text-xs text-gray-400 mb-1">{k}</p>
                <pre className="whitespace-pre-wrap text-sm text-gray-200 bg-[#0d0d0d] border border-[#262626] rounded-lg p-3 font-sans">{v}</pre>
              </div>
            ))}
            {calc && (
              <p className="text-[11px] text-gray-500">
                Comissão base {calc.comissao_base} · bônus {calc.bonificacao} · honorários {calc.honorarios} · entrada líquida {calc.entrada_liquida} · preço total {calc.preco_total}
              </p>
            )}
            <button
              disabled
              title="Disponível após configurar a conta de serviço do Google"
              className="w-full border border-[#333] text-gray-500 py-2.5 rounded-lg cursor-not-allowed"
            >
              Gerar documento no Google Docs (disponível após configurar o Google)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
