import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// SIMULADOR FINANCEIRO — Young (port determinístico da calculadora do n8n v4.2)
// Segurança: roda com service_role no servidor; exige usuário logado (verify_jwt);
// juros NUNCA voltam ao cliente; autonomia checada pelo usuário autenticado.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function norm(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ erro: "METODO", mensagem: "Use POST." }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1) Identidade: usuário autenticado (a partir do JWT enviado pelo front)
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return j({ erro: "NAO_AUTENTICADO", mensagem: "Login obrigatório." }, 401);
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user?.email) return j({ erro: "NAO_AUTENTICADO", mensagem: "Sessão inválida." }, 401);

  // 2) Permissões (allowlist)
  const { data: perfil } = await admin
    .from("simulador_usuarios")
    .select("papel,pode_autonomia,pode_bonificar,ativo")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();
  if (!perfil || !perfil.ativo) return j({ erro: "SEM_PERMISSAO", mensagem: "Acesso não liberado." }, 403);

  // 3) Entrada
  let raw: Record<string, unknown> = {};
  try { raw = await req.json(); } catch { return j({ erro: "ENTRADA", mensagem: "JSON inválido." }, 400); }

  const num_lote = raw.num_lote != null ? String(raw.num_lote) : "";
  const empreendimento_input = String(raw.empreendimento ?? "");
  if (!num_lote) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "num_lote é obrigatório." }, 400);
  if (!empreendimento_input) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "empreendimento é obrigatório." }, 400);

  // 4) Preço/juros do banco (service_role) — busca por num_lote e filtra pelo empreendimento
  const { data: linhas, error: errPreco } = await admin
    .from("comercial_tabela_precos")
    .select("empreendimento,num_lote,preco_av,juros,preco_minimo,created_at")
    .eq("num_lote", num_lote)
    .order("created_at", { ascending: false });
  if (errPreco) return j({ erro: "BUSCA_PRECO", mensagem: errPreco.message }, 502);
  const alvo = norm(empreendimento_input);
  const candidatos = (linhas ?? []).filter((l) => norm(l.empreendimento) === alvo);
  if (candidatos.length === 0) {
    return j({ erro: "LOTE_EMPREENDIMENTO_NAO_ENCONTRADO", mensagem: `Lote ${num_lote} não existe em "${empreendimento_input}".` }, 404);
  }
  const loteDb = candidatos[0];
  const preco_av_banco = parseFloat(String(loteDb.preco_av));
  const juros_banco = parseFloat(String(loteDb.juros));               // NUNCA retornado
  const preco_minimo_db = loteDb.preco_minimo != null ? parseFloat(String(loteDb.preco_minimo)) : null;

  const preco_customizado = raw.preco_customizado === true || raw.preco_customizado === "true";
  const promocional = raw.promocional === true || raw.promocional === "true";

  // 4b) Disponibilidade (Sienge) — aviso suave. Se o lote não estiver "disponível"
  // e o usuário ainda não confirmou, devolve requer_confirmacao SEM calcular.
  // Se confirmar (ou não houver status no Sienge), segue normalmente.
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

  // 5) Promoção (opcional)
  let preco_promocional_db: number | null = null;
  let prazo_maximo_promo_banco = 0;
  let promo_descricao_banco = "";
  if (promocional) {
    const { data: promos } = await admin
      .from("comercial_promocoes")
      .select("id,empreendimento,prazo_maximo,data_inicio,data_fim,descricao,ativa")
      .eq("ativa", true);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const parseD = (s: unknown) => (s ? new Date(String(s) + "T00:00:00") : null);
    const doEmp = (promos ?? []).filter((p) => norm(p.empreendimento) === alvo || norm(p.empreendimento) === "todos");
    const vigentes = doEmp.filter((p) => {
      const ini = parseD(p.data_inicio); const fim = parseD(p.data_fim);
      if (ini && hoje < ini) return false;
      if (fim && hoje > fim) return false;
      return true;
    }).sort((a, b) => {
      const espA = norm(a.empreendimento) === "todos" ? 1 : 0;
      const espB = norm(b.empreendimento) === "todos" ? 1 : 0;
      if (espA !== espB) return espA - espB;
      return (b.prazo_maximo || 0) - (a.prazo_maximo || 0);
    });
    if (vigentes.length === 0) {
      // Como o bot: distingue promoção EXPIRADA de inexistente.
      const expiradas = doEmp.filter((p) => { const fim = parseD(p.data_fim); return fim && hoje > fim; })
        .sort((a, b) => (parseD(b.data_fim)?.getTime() || 0) - (parseD(a.data_fim)?.getTime() || 0));
      if (expiradas.length > 0) {
        const e = expiradas[0];
        const df = e.data_fim ? String(e.data_fim).split("-").reverse().join("/") : "";
        return j({ erro: "PROMO_EXPIRADA", mensagem: `A promoção "${e.descricao || ""}" expirou em ${df}. Desmarque "Promoção" para simular nas condições normais.` });
      }
      return j({ erro: "PROMO_NAO_ATIVA", mensagem: `Não há promoção ativa para "${loteDb.empreendimento}". Desmarque "Promoção" para simular nas condições normais.` });
    }
    const promo = vigentes[0];
    prazo_maximo_promo_banco = parseInt(String(promo.prazo_maximo || 0));
    promo_descricao_banco = promo.descricao || "";
    const { data: precos } = await admin
      .from("comercial_promocoes_precos")
      .select("num_lote,empreendimento,preco_promocional")
      .eq("promocao_id", promo.id)
      .eq("num_lote", num_lote);
    const precoLote = (precos ?? []).find((p) => norm(p.empreendimento) === alvo);
    if (precoLote?.preco_promocional != null && parseFloat(String(precoLote.preco_promocional)) > 0) {
      preco_promocional_db = parseFloat(String(precoLote.preco_promocional));
    } else if (!preco_customizado) {
      return j({ erro: "PROMO_SEM_PRECO_LOTE", mensagem: `Lote ${num_lote} não tem preço promocional na campanha vigente.`, promocao: promo_descricao_banco });
    }
  }

  // 6) Preço aplicado (com autonomia validada pelo usuário logado)
  let valor_av: number;
  if (preco_customizado) {
    if (!perfil.pode_autonomia) return j({ erro: "AUTONOMIA_NEGADA_USUARIO", mensagem: "Seu usuário não tem autonomia para preço customizado." }, 403);
    if (alvo !== "montecarlo") return j({ erro: "AUTONOMIA_EMPREENDIMENTO", mensagem: "Autonomia disponível apenas para Montecarlo." });
    if (preco_minimo_db == null || preco_minimo_db <= 0) return j({ erro: "AUTONOMIA_NEGADA_LOTE", mensagem: "Este lote não tem preço mínimo cadastrado." });
    const valor_custom = parseFloat(String(raw.valor_lote || 0));
    if (!(valor_custom > 0)) return j({ erro: "AUTONOMIA_VALOR_INVALIDO", mensagem: "Preço customizado inválido." });
    if (valor_custom < preco_minimo_db) return j({ erro: "AUTONOMIA_ABAIXO_MINIMO", mensagem: `Preço (R$ ${valor_custom.toFixed(2)}) abaixo do mínimo (R$ ${preco_minimo_db.toFixed(2)}).` });
    valor_av = valor_custom;
  } else if (promocional) {
    valor_av = preco_promocional_db as number;
  } else {
    valor_av = preco_av_banco;
  }

  // 7) Parâmetros (ITBI e cartório derivados no servidor — não confiar do cliente)
  const entrada = parseFloat(String(raw.entrada || 0));      // igual ao bot: falsy -> 0
  const itbi_percentual = (alvo === "montecarlo" || alvo === "morada da coxilha") ? 0.03 : 0.02;
  const cartorio = 2500;
  const taxa_juros_mensal = promocional ? 0 : (juros_banco / 100);
  const prazo_maximo_promo = promocional ? prazo_maximo_promo_banco : 0;

  const reforcos = Array.isArray(raw.reforcos) ? (raw.reforcos as Array<Record<string, unknown>>) : [];
  const prazo_meses_informado = parseInt(String(raw.prazo_meses || raw.prazo || 0)); // igual ao bot: 0/"" caem no fallback
  const parcela_desejada = parseFloat(String(raw.parcela_desejada || 0));

  const LIMITE_REFORCO_APOS_PARCELAS = 6;
  const LIMITES: Record<string, number> = { "aurora": 240, "morada da coxilha": 360 };
  const emp_norm = norm(loteDb.empreendimento);
  let LIMITE_ABSOLUTO_MESES = 180;
  for (const chave in LIMITES) { if (emp_norm.includes(chave)) { LIMITE_ABSOLUTO_MESES = LIMITES[chave]; break; } }

  if (!(valor_av > 0)) return j({ erro: "VALOR_INVALIDO", mensagem: "Valor do lote inválido." });
  if (!Number.isFinite(entrada) || entrada < 500) return j({ erro: "ENTRADA_MINIMA", mensagem: "Entrada mínima é R$ 500,00." });
  if (entrada > valor_av) return j({ erro: "ENTRADA_ALTA", mensagem: "Entrada não pode ser maior que o valor do lote." });

  for (let i = 0; i < reforcos.length; i++) {
    const mes = parseInt(String(reforcos[i].mes || 0));
    const valor = parseFloat(String(reforcos[i].valor || 0));
    if (!(valor > 0)) return j({ erro: "REFORCO_VALOR", mensagem: `Reforço ${i + 1} com valor inválido.` });
    if (!(mes >= 1)) return j({ erro: "REFORCO_MES", mensagem: `Reforço ${i + 1}: informe uma data futura (a partir do próximo mês).` });
    if (mes > LIMITE_ABSOLUTO_MESES) return j({ erro: "REFORCO_PRAZO", mensagem: `Reforço ${i + 1} (mês ${mes}) ultrapassa ${LIMITE_ABSOLUTO_MESES} meses.` });
  }
  if (promocional && prazo_maximo_promo > 0 && prazo_meses_informado > prazo_maximo_promo) {
    return j({ erro: "PRAZO_PROMO", mensagem: `A promoção permite no máximo ${prazo_maximo_promo} parcelas.`, prazo_maximo_promocao: prazo_maximo_promo });
  }

  // Reforços a valor presente
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
  const limite_termos_real = (promocional && prazo_maximo_promo > 0) ? Math.min(LIMITE_ABSOLUTO_MESES, prazo_maximo_promo) : LIMITE_ABSOLUTO_MESES;
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
    if (prazo_meses > LIMITE_ABSOLUTO_MESES) return j({ erro: "PRAZO_MAXIMO", mensagem: `Prazo máximo é ${LIMITE_ABSOLUTO_MESES} meses.` });
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
    if (prazo_meses > LIMITE_ABSOLUTO_MESES) return j({ erro: "PRAZO_LONGO", mensagem: `Levaria ${prazo_meses} meses (limite ${LIMITE_ABSOLUTO_MESES}). Parcela mínima p/ ${LIMITE_ABSOLUTO_MESES} meses: R$ ${p_min_real.toFixed(2)}.` });
    if (promocional && prazo_maximo_promo > 0 && prazo_meses > prazo_maximo_promo) return j({ erro: "PRAZO_PROMO", mensagem: `A promoção permite no máximo ${prazo_maximo_promo} parcelas. Parcela mínima: R$ ${p_min_real.toFixed(2)}.` });
  } else {
    return j({ erro: "PARAMETROS_INSUFICIENTES", mensagem: "Informe prazo_meses OU parcela_desejada." }, 400);
  }

  const ultimo_reforco_mes = reforcos.length ? Math.max(...reforcos.map((r) => parseInt(String(r.mes || 0)))) : 0;
  if (Math.max(prazo_meses, ultimo_reforco_mes) > LIMITE_ABSOLUTO_MESES) {
    return j({ erro: "PRAZO_TOTAL", mensagem: `O último pagamento ultrapassa ${LIMITE_ABSOLUTO_MESES} meses.` });
  }
  if (prazo_meses > 0 && ultimo_reforco_mes > prazo_meses + LIMITE_REFORCO_APOS_PARCELAS) {
    return j({ erro: "REFORCO_DISTANTE", mensagem: `Reforços só até o mês ${prazo_meses + LIMITE_REFORCO_APOS_PARCELAS}.` });
  }

  const total_parcelas = parcela_mensal * prazo_meses;
  valor_nominal = entrada + total_parcelas + total_reforcos_nominal;
  const multiplicador = valor_av > 0 ? valor_nominal / valor_av : 0;

  // Comissão (interna) — 5% sobre a base. Base = preço aplicado na autonomia;
  // senão o preço de tabela (na promoção a base continua sendo o de tabela).
  const base_comissao = preco_customizado ? valor_av : preco_av_banco;
  const comissao = base_comissao * 0.05;
  // Bônus (opcional) — só usuário habilitado; teto: comissão + bônus ≤ entrada.
  const bonus_pedido = parseFloat(String(raw.bonus || 0)) || 0;
  let bonus = 0;
  if (bonus_pedido > 0) {
    if (!perfil.pode_bonificar) return j({ erro: "BONUS_NEGADO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
    if (comissao + bonus_pedido > entrada) {
      return j({ erro: "BONUS_TETO", mensagem: `Bônus alto demais: comissão + bônus (R$ ${(comissao + bonus_pedido).toFixed(2)}) não pode passar da entrada (R$ ${entrada.toFixed(2)}).` });
    }
    bonus = bonus_pedido;
  }

  // Resposta ao cliente — SEM juros.
  return j({
    sucesso: true,
    empreendimento: loteDb.empreendimento,
    num_lote: loteDb.num_lote,
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
      parcela_mensal: Number(parcela_mensal.toFixed(2)),
      total_parcelas: Number(total_parcelas.toFixed(2)),
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
