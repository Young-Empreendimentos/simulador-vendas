import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-call",
};

const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function norm(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ erro: "METODO", mensagem: "Use POST." }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const db = admin.schema("comercial");

  // Chamada confiável servidor→servidor (simular-externo): pula o login @young e usa um perfil mínimo
  // (sem autonomia, sem bônus, sem restrição de empreendimento). Gated pelo segredo; sem ele, nada muda.
  const INTERNAL_SECRET = Deno.env.get("INTERNAL_CALL_SECRET") || "";
  const trustedInternal = !!INTERNAL_SECRET && (req.headers.get("x-internal-call") || "") === INTERNAL_SECRET;

  // deno-lint-ignore no-explicit-any
  let perfil: any;
  if (trustedInternal) {
    perfil = { papel: "externo", pode_autonomia: false, pode_bonificar: false, ativo: true, empreendimentos: [] };
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return j({ erro: "NAO_AUTENTICADO", mensagem: "Login obrigatório." }, 401);
    const { data: userData } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user?.email) return j({ erro: "NAO_AUTENTICADO", mensagem: "Sessão inválida." }, 401);
    const { data: p } = await db
      .from("simulador_usuarios")
      .select("papel,pode_autonomia,pode_bonificar,ativo,empreendimentos")
      .eq("email", user.email.toLowerCase())
      .maybeSingle();
    if (!p || !p.ativo) return j({ erro: "SEM_PERMISSAO", mensagem: "Acesso não liberado." }, 403);
    perfil = p;
  }

  let raw: Record<string, unknown> = {};
  try { raw = await req.json(); } catch { return j({ erro: "ENTRADA", mensagem: "JSON inválido." }, 400); }

  const num_lote = raw.num_lote != null ? String(raw.num_lote) : "";
  const empreendimento_input = String(raw.empreendimento ?? "");
  if (!num_lote) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "num_lote é obrigatório." }, 400);
  if (!empreendimento_input) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "empreendimento é obrigatório." }, 400);

  const permitidos = Array.isArray(perfil.empreendimentos) ? perfil.empreendimentos as string[] : [];
  if (permitidos.length > 0 && !permitidos.map(norm).includes(norm(empreendimento_input))) {
    return j({ erro: "EMPREENDIMENTO_NAO_LIBERADO", mensagem: "Seu usuário não tem acesso a este empreendimento." }, 403);
  }

  const { data: linhas, error: errPreco } = await db
    .from("comercial_tabela_precos")
    .select("empreendimento,num_lote,preco_av,juros,preco_minimo,created_at")
    .eq("num_lote", num_lote)
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false });
  if (errPreco) return j({ erro: "BUSCA_PRECO", mensagem: errPreco.message }, 502);
  const alvo = norm(empreendimento_input);
  const candidatos = (linhas ?? []).filter((l) => norm(l.empreendimento) === alvo);
  if (candidatos.length === 0) {
    return j({ erro: "LOTE_EMPREENDIMENTO_NAO_ENCONTRADO", mensagem: `Lote ${num_lote} não existe em "${empreendimento_input}".` }, 404);
  }
  const loteDb = candidatos[0];
  if (candidatos.some((c) => !c.created_at)) {
    return j({ erro: "LOTE_SEM_DATA_CADASTRO", mensagem: `O lote ${num_lote} de ${loteDb.empreendimento} tem preço sem data de cadastro (created_at) no banco — não dá pra saber qual valor é o mais atual. Peça ao Comercial para atualizar/recadastrar o preço do lote antes de simular.` }, 409);
  }
  const preco_av_banco = parseFloat(String(loteDb.preco_av));
  const juros_banco = parseFloat(String(loteDb.juros));
  const preco_minimo_db = loteDb.preco_minimo != null ? parseFloat(String(loteDb.preco_minimo)) : null;

  const preco_customizado = raw.preco_customizado === true || raw.preco_customizado === "true";
  const avista = raw.avista === true || raw.avista === "true";
  const promocional = (raw.promocional === true || raw.promocional === "true") && !avista;

  const confirmar = raw.confirmar === true || raw.confirmar === "true";
  const STATUS_LABEL: Record<string, string> = {
    D: "disponível", V: "vendido", R: "reserva técnica", E: "permuta",
    G: "vendido a terceiros", T: "transferido", P: "proposta",
  };
  const { data: cs } = await admin.rpc("get_status_lote", { p_nome: empreendimento_input, p_num: num_lote });
  const status_cod = typeof cs === "string" ? cs : null;
  const disponivel = status_cod === "D";
  const status_lote = status_cod ? (STATUS_LABEL[status_cod] ?? "indisponível") : null;
  if (status_cod && !disponivel && !confirmar) {
    return j({
      requer_confirmacao: true,
      status_lote,
      empreendimento: loteDb.empreendimento,
      num_lote: loteDb.num_lote,
      mensagem: `O lote ${loteDb.num_lote} de ${loteDb.empreendimento} está como ${status_lote}. Deseja simular mesmo assim?`,
    });
  }

  let preco_promocional_db: number | null = null;
  let prazo_maximo_promo_banco = 0;
  let promo_descricao_banco = "";
  if (promocional) {
    const { data: promos } = await db
      .from("comercial_promocoes")
      .select("id,empreendimento,prazo_maximo,data_inicio,data_fim,descricao");
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const parseD = (s: unknown) => (s ? new Date(String(s) + "T00:00:00") : null);
    const fmtBR = (s: unknown) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "");
    const doEmp = (promos ?? []).filter((p) => norm(p.empreendimento) === alvo || norm(p.empreendimento) === "todos");
    const comData = doEmp.filter((p) => parseD(p.data_fim));
    const vigentes = comData.filter((p) => {
      const ini = parseD(p.data_inicio); const fim = parseD(p.data_fim)!;
      if (ini && hoje < ini) return false;
      if (hoje > fim) return false;
      return true;
    }).sort((a, b) => {
      const espA = norm(a.empreendimento) === "todos" ? 1 : 0;
      const espB = norm(b.empreendimento) === "todos" ? 1 : 0;
      if (espA !== espB) return espA - espB;
      return (b.prazo_maximo || 0) - (a.prazo_maximo || 0);
    });
    if (vigentes.length === 0) {
      const expiradas = comData.filter((p) => hoje > (parseD(p.data_fim) as Date))
        .sort((a, b) => (parseD(b.data_fim)?.getTime() || 0) - (parseD(a.data_fim)?.getTime() || 0));
      if (expiradas.length > 0) {
        const e = expiradas[0];
        return j({ erro: "PROMO_EXPIRADA", mensagem: `A promoção \"${e.descricao || ""}\" terminou em ${fmtBR(e.data_fim)}. Desmarque \"Promoção\" para simular nas condições normais.` });
      }
      const futuras = comData.filter((p) => { const ini = parseD(p.data_inicio); return ini && hoje < ini; })
        .sort((a, b) => (parseD(a.data_inicio)?.getTime() || 0) - (parseD(b.data_inicio)?.getTime() || 0));
      if (futuras.length > 0) {
        const f = futuras[0];
        return j({ erro: "PROMO_FUTURA", mensagem: `A promoção \"${f.descricao || ""}\" só começa em ${fmtBR(f.data_inicio)}. Desmarque \"Promoção\" para simular nas condições normais.` });
      }
      const semData = doEmp.length > 0 && comData.length === 0;
      if (semData) {
        return j({ erro: "PROMO_SEM_DATA", mensagem: `A promoção de \"${loteDb.empreendimento}\" está sem data de vigência cadastrada — não dá pra simular como promoção. Cadastre a data de término ou desmarque \"Promoção\".` });
      }
      return j({ erro: "PROMO_NAO_ATIVA", mensagem: `Não há promoção vigente para \"${loteDb.empreendimento}\". Desmarque \"Promoção\" para simular nas condições normais.` });
    }
    const { data: precosVig } = await db
      .from("comercial_promocoes_precos")
      .select("promocao_id,num_lote,empreendimento,preco_promocional")
      .in("promocao_id", vigentes.map((p) => p.id))
      .eq("num_lote", num_lote);
    const precoDaPromo = (pid: unknown): number => {
      const r = (precosVig ?? []).find((p) => p.promocao_id === pid && norm(p.empreendimento) === alvo);
      const v = r?.preco_promocional != null ? parseFloat(String(r.preco_promocional)) : 0;
      return v > 0 ? v : 0;
    };
    const promo = vigentes.find((p) => precoDaPromo(p.id) > 0) ?? vigentes[0];
    prazo_maximo_promo_banco = parseInt(String(promo.prazo_maximo || 0));
    promo_descricao_banco = promo.descricao || "";
    const precoEscolhido = precoDaPromo(promo.id);
    if (precoEscolhido > 0) {
      preco_promocional_db = precoEscolhido;
    } else if (!preco_customizado) {
      return j({ erro: "PROMO_SEM_PRECO_LOTE", mensagem: `Lote ${num_lote} não tem preço promocional na campanha vigente.`, promocao: promo_descricao_banco });
    }
  }

  let valor_av: number;
  if (preco_customizado) {
    if (!perfil.pode_autonomia) return j({ erro: "AUTONOMIA_NEGADA_USUARIO", mensagem: "Seu usuário não tem autonomia para preço customizado." }, 403);
    const valor_custom = parseFloat(String(raw.valor_lote || 0));
    if (!(valor_custom > 0)) return j({ erro: "AUTONOMIA_VALOR_INVALIDO", mensagem: "Preço customizado inválido." });
    if (valor_custom < preco_av_banco) {
      if (preco_minimo_db == null || preco_minimo_db <= 0) {
        return j({ erro: "AUTONOMIA_SEM_DESCONTO", mensagem: `Desconto não liberado para ${loteDb.empreendimento} (sem preço mínimo cadastrado). Você pode manter ou aumentar o valor de tabela (R$ ${preco_av_banco.toFixed(2)}).` });
      }
      if (valor_custom < preco_minimo_db) {
        return j({ erro: "AUTONOMIA_ABAIXO_MINIMO", mensagem: `Preço (R$ ${valor_custom.toFixed(2)}) abaixo do mínimo (R$ ${preco_minimo_db.toFixed(2)}).` });
      }
    }
    valor_av = valor_custom;
  } else if (promocional) {
    valor_av = preco_promocional_db as number;
  } else {
    valor_av = preco_av_banco;
  }

  const entrada = parseFloat(String(raw.entrada || 0));
  const itbi_percentual = (alvo === "montecarlo") ? 0.03 : 0.02;
  const cartorio = 2500;
  const taxa_juros_mensal = promocional ? 0 : (juros_banco / 100);
  const prazo_maximo_promo = promocional ? prazo_maximo_promo_banco : 0;

  if (avista) {
    if (!(valor_av > 0)) return j({ erro: "VALOR_INVALIDO", mensagem: "Valor do lote inválido." });
    const itbi_av = valor_av * itbi_percentual;
    const base_comissao_av = (preco_customizado && preco_minimo_db != null && preco_minimo_db > 0) ? valor_av : preco_av_banco;
    const comissao_av = base_comissao_av * 0.05;
    const bonus_pedido_av = parseFloat(String(raw.bonus || 0)) || 0;
    let bonus_av = 0;
    if (bonus_pedido_av > 0) {
      if (!perfil.pode_bonificar) return j({ erro: "BONUS_NEGADO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
      bonus_av = bonus_pedido_av;
    }
    const total_av = valor_av + itbi_av + cartorio;
    return j({
      sucesso: true,
      empreendimento: loteDb.empreendimento,
      num_lote: loteDb.num_lote,
      avista: true,
      promocional: false,
      promo_descricao: null,
      autonomia_aplicada: preco_customizado,
      status_lote,
      disponivel,
      interno: {
        base_comissao: Number(base_comissao_av.toFixed(2)),
        comissao: Number(comissao_av.toFixed(2)),
        bonus: Number(bonus_av.toFixed(2)),
        comissao_total: Number((comissao_av + bonus_av).toFixed(2)),
      },
      resumo: {
        valor_lote_av: Number(valor_av.toFixed(2)),
        valor_tabela: Number(preco_av_banco.toFixed(2)),
        entrada: 0,
        prazo_meses: 0,
        parcela_mensal: 0,
        ultima_parcela: 0,
        total_parcelas: 0,
        total_reforcos: 0,
        itbi: Number(itbi_av.toFixed(2)),
        itbi_percentual: itbi_percentual * 100,
        cartorio,
        total_pago: Number(total_av.toFixed(2)),
        multiplicador: 1,
      },
      reforcos: [],
    });
  }

  const reforcos = Array.isArray(raw.reforcos) ? (raw.reforcos as Array<Record<string, unknown>>) : [];
  const prazo_meses_informado = parseInt(String(raw.prazo_meses || raw.prazo || 0));
  const parcela_desejada = parseFloat(String(raw.parcela_desejada || 0));

  const LIMITE_REFORCO_APOS_PARCELAS = 6;
  const emp_norm = norm(loteDb.empreendimento);
  let LIMITE_ABSOLUTO_MESES = 180;
  {
    const { data: empRows } = await db.from("comercial_empreendimentos").select("nome,limite_parcelas");
    const lim = (empRows ?? []).find((e) => norm(e.nome) === emp_norm)?.limite_parcelas;
    if (lim != null && Number(lim) > 0) LIMITE_ABSOLUTO_MESES = Number(lim);
  }
  const LIMITE_MESES = (promocional && prazo_maximo_promo > 0) ? prazo_maximo_promo : LIMITE_ABSOLUTO_MESES;

  if (!(valor_av > 0)) return j({ erro: "VALOR_INVALIDO", mensagem: "Valor do lote inválido." });
  // Entrada mínima R$ 500 — EXCETO no modo comissão parcelada do corretor (Entrada Young pode ser 0, entrada toda virou honorários do corretor).
  // Gated pelo front (permite_entrada_baixa=true); fluxo normal mantém 500.
  const permiteEntradaBaixa = raw.permite_entrada_baixa === true || raw.permite_entrada_baixa === "true";
  const minEntrada = 500; // Young SEMPRE fica com no minimo R$ 500 (nunca 0), em qualquer simulador.
  if (!Number.isFinite(entrada) || entrada < minEntrada) return j({ erro: "ENTRADA_MINIMA", mensagem: "Entrada mínima é R$ 500,00 (a Young fica com pelo menos R$ 500)." });
  if (entrada > valor_av) return j({ erro: "ENTRADA_ALTA", mensagem: "Entrada não pode ser maior que o valor do lote." });

  for (let i = 0; i < reforcos.length; i++) {
    const mes = parseInt(String(reforcos[i].mes || 0));
    const valor = parseFloat(String(reforcos[i].valor || 0));
    if (!(valor > 0)) return j({ erro: "REFORCO_VALOR", mensagem: `Reforço ${i + 1} com valor inválido.` });
    if (!(mes >= 1)) return j({ erro: "REFORCO_MES", mensagem: `Reforço ${i + 1}: informe uma data futura (a partir do próximo mês).` });
    if (mes > LIMITE_MESES) return j({ erro: "REFORCO_PRAZO", mensagem: `Reforço ${i + 1} (mês ${mes}) ultrapassa ${LIMITE_MESES} meses.` });
  }
  if (promocional && prazo_maximo_promo > 0 && prazo_meses_informado > prazo_maximo_promo) {
    return j({ erro: "PRAZO_PROMO", mensagem: `A promoção permite no máximo ${prazo_maximo_promo} parcelas.`, prazo_maximo_promocao: prazo_maximo_promo });
  }

  let vp_reforcos = 0, total_reforcos_nominal = 0;
  const detalhes_reforcos: Array<{ mes: number; valor: string; data_str: string }> = [];
  for (const ref of reforcos) {
    const valor = parseFloat(String(ref.valor || 0));
    const mes = parseInt(String(ref.mes || 0));
    if (valor > 0 && mes > 0) {
      vp_reforcos += valor / Math.pow(1 + taxa_juros_mensal, mes);
      total_reforcos_nominal += valor;
      detalhes_reforcos.push({ mes, valor: valor.toFixed(2), data_str: String(ref.data_str ?? ref.data ?? "") });
    }
  }

  const calcularParcela = (saldo: number, taxa: number, prazo: number): number => {
    if (saldo <= 0) return 0;
    if (taxa === 0) return saldo / prazo;
    return saldo * (taxa * Math.pow(1 + taxa, prazo)) / (Math.pow(1 + taxa, prazo) - 1);
  };
  const limite_termos_real = LIMITE_MESES;
  const obterParcelaMinima = (): number => {
    let t_itbi = 0, t_parcela = 0, t_itbi_ant = 0;
    for (let k = 0; k < 50; k++) {
      const t_saldo = valor_av - entrada - vp_reforcos + t_itbi + cartorio;
      if (t_saldo <= 0) return 0;
      t_parcela = calcularParcela(t_saldo, taxa_juros_mensal, limite_termos_real);
      const t_nom = entrada + (t_parcela * limite_termos_real) + total_reforcos_nominal;
      t_itbi = t_nom * itbi_percentual;
      if (Math.abs(t_itbi - t_itbi_ant) < 0.01) break;
      t_itbi_ant = t_itbi;
    }
    return t_parcela;
  };

  let prazo_meses = prazo_meses_informado, parcela_mensal = 0, itbi = 0, valor_nominal = 0;

  if (prazo_meses_informado > 0) {
    if (prazo_meses > LIMITE_MESES) return j({ erro: "PRAZO_MAXIMO", mensagem: `Prazo máximo é ${LIMITE_MESES} meses.` });
    let itbi_ant = 0;
    for (let i = 0; i < 50; i++) {
      const saldo = valor_av - entrada - vp_reforcos + itbi + cartorio;
      parcela_mensal = calcularParcela(saldo, taxa_juros_mensal, prazo_meses);
      valor_nominal = entrada + (parcela_mensal * prazo_meses) + total_reforcos_nominal;
      itbi = valor_nominal * itbi_percentual;
      if (Math.abs(itbi - itbi_ant) < 0.01) break;
      itbi_ant = itbi;
    }
  } else if (parcela_desejada > 0) {
    parcela_mensal = parcela_desejada;
    let itbi_ant = 0;
    for (let i = 0; i < 50; i++) {
      const saldo = valor_av - entrada - vp_reforcos + itbi + cartorio;
      if (saldo <= 0) { prazo_meses = 0; parcela_mensal = 0; break; }
      if (taxa_juros_mensal === 0) {
        prazo_meses = Math.ceil(saldo / parcela_desejada);
      } else {
        if (parcela_desejada <= saldo * taxa_juros_mensal) {
          const p_min = obterParcelaMinima();
          return j({ erro: "PARCELA_BAIXA", mensagem: `A parcela não cobre juros e ITBI. Para ${limite_termos_real} meses, a mínima é R$ ${p_min.toFixed(2)}.` });
        }
        prazo_meses = Math.ceil(Math.log(parcela_desejada / (parcela_desejada - saldo * taxa_juros_mensal)) / Math.log(1 + taxa_juros_mensal));
      }
      valor_nominal = entrada + (parcela_mensal * prazo_meses) + total_reforcos_nominal;
      itbi = valor_nominal * itbi_percentual;
      if (Math.abs(itbi - itbi_ant) < 0.01) break;
      itbi_ant = itbi;
    }
    const p_min_real = obterParcelaMinima();
    if (prazo_meses > LIMITE_MESES) return j({ erro: "PRAZO_LONGO", mensagem: `Levaria ${prazo_meses} meses (limite ${LIMITE_MESES}). Parcela mínima p/ ${LIMITE_MESES} meses: R$ ${p_min_real.toFixed(2)}.` });
    if (promocional && prazo_maximo_promo > 0 && prazo_meses > prazo_maximo_promo) return j({ erro: "PRAZO_PROMO", mensagem: `A promoção permite no máximo ${prazo_maximo_promo} parcelas. Parcela mínima: R$ ${p_min_real.toFixed(2)}.` });
  } else {
    return j({ erro: "PARAMETROS_INSUFICIENTES", mensagem: "Informe prazo_meses OU parcela_desejada." }, 400);
  }

  const ultimo_reforco_mes = reforcos.length ? Math.max(...reforcos.map((r) => parseInt(String(r.mes || 0)))) : 0;
  if (Math.max(prazo_meses, ultimo_reforco_mes) > LIMITE_MESES) {
    return j({ erro: "PRAZO_TOTAL", mensagem: `O último pagamento ultrapassa ${LIMITE_MESES} meses.` });
  }
  if (prazo_meses > 0 && ultimo_reforco_mes > prazo_meses + LIMITE_REFORCO_APOS_PARCELAS) {
    return j({ erro: "REFORCO_DISTANTE", mensagem: `Reforços só até o mês ${prazo_meses + LIMITE_REFORCO_APOS_PARCELAS}.` });
  }

  const total_parcelas = parcela_mensal * prazo_meses;
  valor_nominal = entrada + total_parcelas + total_reforcos_nominal;
  const multiplicador = valor_av > 0 ? valor_nominal / valor_av : 0;

  const _pm = Number(parcela_mensal.toFixed(2));
  const _tp = Number(total_parcelas.toFixed(2));
  const ultima_parcela = prazo_meses > 1 ? Number((_tp - _pm * (prazo_meses - 1)).toFixed(2)) : _pm;

  const base_comissao = (preco_customizado && preco_minimo_db != null && preco_minimo_db > 0) ? valor_av : preco_av_banco;
  const comissao = base_comissao * 0.05;
  const bonus_pedido = parseFloat(String(raw.bonus || 0)) || 0;
  let bonus = 0;
  if (bonus_pedido > 0) {
    if (!perfil.pode_bonificar) return j({ erro: "BONUS_NEGADO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
    if (comissao + bonus_pedido > entrada) {
      return j({ erro: "BONUS_TETO", mensagem: `Bônus alto demais: comissão + bônus (R$ ${(comissao + bonus_pedido).toFixed(2)}) não pode passar da entrada (R$ ${entrada.toFixed(2)}).` });
    }
    bonus = bonus_pedido;
  }

  return j({
    sucesso: true,
    empreendimento: loteDb.empreendimento,
    num_lote: loteDb.num_lote,
    avista: false,
    promocional: promocional,
    promo_descricao: promo_descricao_banco || null,
    autonomia_aplicada: preco_customizado,
    status_lote,
    disponivel,
    interno: {
      base_comissao: Number(base_comissao.toFixed(2)),
      comissao: Number(comissao.toFixed(2)),
      bonus: Number(bonus.toFixed(2)),
      comissao_total: Number((comissao + bonus).toFixed(2)),
    },
    resumo: {
      valor_lote_av: Number(valor_av.toFixed(2)),
      valor_tabela: Number(preco_av_banco.toFixed(2)),
      entrada: Number(entrada.toFixed(2)),
      prazo_meses,
      parcela_mensal: _pm,
      ultima_parcela,
      total_parcelas: _tp,
      total_reforcos: Number(total_reforcos_nominal.toFixed(2)),
      itbi: Number(itbi.toFixed(2)),
      itbi_percentual: itbi_percentual * 100,
      cartorio,
      total_pago: Number(valor_nominal.toFixed(2)),
      multiplicador: Number(multiplicador.toFixed(2)),
    },
    reforcos: detalhes_reforcos,
  });
});
