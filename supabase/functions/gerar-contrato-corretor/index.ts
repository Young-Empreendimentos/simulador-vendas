import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function norm(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const fmt = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");

function dadosBancariosCorretor(c) {
  const texto = String(c?.dados_bancarios ?? "").trim();
  if (texto) return texto;
  const nome = String(c?.banco_nome ?? "").trim();
  const ag = String(c?.banco_agencia ?? "").trim();
  const conta = String(c?.banco_conta ?? "").trim();
  const tipo = String(c?.banco_tipo ?? "").trim();
  const pix = String(c?.banco_chave_pix ?? "").trim();
  const partes = [];
  if (nome) partes.push(`Banco ${nome}`);
  if (ag) partes.push(`ag. ${ag}`);
  if (conta) partes.push(`conta ${tipo ? tipo + " " : ""}${conta}`);
  if (pix) partes.push(`PIX: ${pix}`);
  return partes.join(", ");
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const dataExtenso = (d) => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;

function extenso(valor) {
  const n = Math.round(Number(valor) * 100);
  const reais = Math.floor(n / 100);
  const centavos = n % 100;
  const unidades = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
  const dezenas = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const centenas = ["", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
  function grupo(x) {
    const c = Math.floor(x / 100);
    const resto = x % 100;
    const d = Math.floor(resto / 10);
    const u = resto % 10;
    const parts = [];
    if (c > 0) { if (c === 1 && resto > 0) parts.push("cento"); else parts.push(centenas[c]); }
    if (resto >= 20) { parts.push(dezenas[d]); if (u > 0) parts.push(unidades[u]); }
    else if (resto > 0) parts.push(unidades[resto]);
    return parts.join(" e ");
  }
  function parteInteira(x) {
    if (x === 0) return "zero";
    const bilhoes = Math.floor(x / 1000000000);
    const milhoes = Math.floor((x % 1000000000) / 1000000);
    const milhares = Math.floor((x % 1000000) / 1000);
    const resto = x % 1000;
    const parts = [];
    if (bilhoes > 0) parts.push(grupo(bilhoes) + (bilhoes === 1 ? " bilhão" : " bilhões"));
    if (milhoes > 0) parts.push(grupo(milhoes) + (milhoes === 1 ? " milhão" : " milhões"));
    if (milhares > 0) { if (milhares === 1 && resto === 0) parts.push("mil"); else parts.push(grupo(milhares) + " mil"); }
    if (resto > 0) parts.push(grupo(resto));
    return parts.join(" e ");
  }
  let r = "";
  if (reais > 0) r += parteInteira(reais) + (reais === 1 ? " real" : " reais");
  if (centavos > 0) { if (reais > 0) r += " e "; r += parteInteira(centavos) + (centavos === 1 ? " centavo" : " centavos"); }
  if (!r) r = "zero reais";
  return r;
}
const vf = (valor) => `R$ ${fmt(valor)} (${extenso(valor)})`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PASTA_ID = Deno.env.get("CONTRATO_PASTA_ID") || "18W0BBrWOIhfAz1eGfDi1itly-KZl5ULF";
const STATUS_LABEL = { D: "disponível", V: "vendido", R: "reserva técnica", E: "permuta", G: "vendido a terceiros", T: "transferido", P: "proposta" };

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPrivateKey(pem) {
  const clean = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function googleToken(saJson, sub) {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const claims = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  if (sub) claims.sub = sub;
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}` });
  const t = await r.json();
  if (!t.access_token) throw new Error("token: " + JSON.stringify(t).slice(0, 200));
  return t.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ erro: "METODO", mensagem: "Use POST." }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const db = admin.schema("comercial");

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return j({ erro: "NAO_AUTENTICADO", mensagem: "Login obrigatório." }, 401);
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user?.email) return j({ erro: "NAO_AUTENTICADO", mensagem: "Sessão inválida." }, 401);
  const { data: perfil } = await db
    .from("simulador_usuarios").select("nome,papel,pode_autonomia,pode_bonificar,ativo,empreendimentos")
    .eq("email", user.email.toLowerCase()).maybeSingle();
  if (!perfil || !perfil.ativo) return j({ erro: "SEM_PERMISSAO", mensagem: "Acesso não liberado." }, 403);

  let raw = {};
  try { raw = await req.json(); } catch { return j({ erro: "ENTRADA", mensagem: "JSON inválido." }, 400); }

  const tipo = String(raw.tipo_contrato || "aprazo").toLowerCase();
  const empreendimento_input = String(raw.empreendimento ?? "");
  const num_lote = raw.num_lote != null ? String(raw.num_lote) : String(raw.Lote ?? "");
  if (!num_lote || !empreendimento_input) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "empreendimento e num_lote são obrigatórios." }, 400);
  const alvo = norm(empreendimento_input);

  const _perm = Array.isArray(perfil.empreendimentos) ? perfil.empreendimentos : [];
  if (_perm.length > 0 && !_perm.map(norm).includes(alvo)) return j({ erro: "EMPREENDIMENTO_NAO_LIBERADO", mensagem: "Seu usuário não tem acesso a este empreendimento." }, 403);

  // Reserva (sistema de Reservas / schema marketing): checa se o lote já está reservado,
  // pra avisar quem reservou e preencher o contrato com os dados da reserva.
  let reservaInfo = { usa_reservas: false, reservado: false, reserva: null };
  try {
    const { data: ri } = await admin.rpc("get_reserva_lote", { p_emp: empreendimento_input, p_num: num_lote });
    if (ri && typeof ri === "object") reservaInfo = ri;
  } catch { /* reservas indisponível -> segue sem travar */ }
  const reserva = reservaInfo.reserva;
  const foiVoce = !!reserva && norm(reserva.criado_por_email) === norm(user.email);

  if (raw.so_reserva === true || raw.so_reserva === "true") {
    return j({
      sucesso: true,
      usa_reservas: reservaInfo.usa_reservas,
      reservado: reservaInfo.reservado,
      status_lote: reservaInfo.status_lote ?? null,
      foi_voce: foiVoce,
      reserva,
    });
  }

  const valor_lote_av = round2(raw.valor_lote_av || 0);
  const entrada_bruta = round2(raw.entrada_bruta || raw.entrada || 0);
  const parcela = round2(raw.parcela_mensal || 0);
  const prazo = parseInt(String(raw.prazo_meses || 0));
  const itbi = round2(raw.itbi || 0);
  const cartorio = round2(raw.cartorio || raw.cartorio_fixo || 0);
  const itbi_cartorio = round2(itbi + cartorio);
  const data_entrada = String(raw.data_entrada || "");
  const data_prim_venc = String(raw.data_primeiro_vencimento || "");
  const reforcos = (Array.isArray(raw.reforcos) ? raw.reforcos : [])
    .map((r) => ({ valor: round2(r.valor || 0), data_str: String(r.data_str || r.data || "") }))
    .filter((r) => r.valor > 0);

  const tem_corretor = !!raw.tem_corretor;
  const bonus_solicitado = round2(raw.bonus_comissao || 0);
  const gerar = raw.gerar === true || raw.gerar === "true";

  // ── MODO comissão parcelada (OPÇÃO NOVA, isolada) ──
  // Só liga com corretor + à prazo + flag. Sem o flag, TUDO roda como antes.
  // entrada_bruta = Entrada Young (vai pra empresa, desconta do lote). A comissão é paga à PARTE:
  // entrada_corretor (na assinatura) + comissao_itens (parcelas/data), direto pelo cliente ao corretor.
  const comissaoParcelada = tem_corretor && tipo !== "avista" &&
    (raw.comissao_corretor_parcelada === true || raw.comissao_corretor_parcelada === "true");
  const entrada_corretor = round2(raw.entrada_corretor || 0);
  const comissao_itens = (Array.isArray(raw.comissao_itens) ? raw.comissao_itens : [])
    .map((r) => ({ valor: round2(r.valor || 0), data_str: String(r.data_str || r.data || "") }))
    .filter((r) => r.valor > 0);

  const { data: dets } = await db
    .from("comercial_lotes_detalhes")
    .select("empreendimento,num_lote,matricula,area,onus,proprietario")
    .eq("num_lote", num_lote);
  const det = (dets ?? []).find((d) => norm(d.empreendimento) === alvo);
  if (!det) return j({ erro: "LOTE_DETALHES_NAO_ENCONTRADO", mensagem: `Sem dados cadastrais (matrícula/área/proprietário) para o lote ${num_lote} de "${empreendimento_input}".` }, 404);
  const proprietario = norm(det.proprietario) === "horizonte" ? "horizonte" : "young";
  const matricula = String(det.matricula ?? "");
  const area = String(det.area ?? "");
  const onusVal = (det.onus == null || String(det.onus).trim() === "" || norm(det.onus) === "n") ? "Não há." : String(det.onus);

  const { data: templates } = await db
    .from("comercial_templates_contratos")
    .select("empreendimento,proprietario,id_doc_avista,id_doc_aprazo");
  const tRow = (templates ?? []).find((t) => norm(t.empreendimento) === alvo && norm(t.proprietario) === proprietario)
    ?? (templates ?? []).find((t) => norm(t.empreendimento) === alvo);
  const template_id = tRow ? (tipo === "avista" ? (tRow.id_doc_avista || "") : (tRow.id_doc_aprazo || "")) : "";
  if (!template_id) return j({ erro: "TEMPLATE_NAO_ENCONTRADO", mensagem: `Template ${tipo === "avista" ? "à vista" : "à prazo"} não cadastrado para "${empreendimento_input}" (${proprietario}).` }, 404);

  const { data: dbs } = await db
    .from("comercial_dados_bancarios").select("empreendimento,dados_bancarios,proprietario");
  const dbRow = (dbs ?? []).find((x) => norm(x.empreendimento) === alvo && norm(x.proprietario) === proprietario);
  const dados_banco_emp = String(dbRow?.dados_bancarios ?? "");

  const { data: linhas } = await db
    .from("comercial_tabela_precos").select("empreendimento,num_lote,preco_av,preco_minimo,created_at")
    .eq("num_lote", num_lote).order("created_at", { ascending: false });
  const precoRow = (linhas ?? []).find((l) => norm(l.empreendimento) === alvo);
  const preco_av_tabela = round2(precoRow?.preco_av || 0);
  const preco_minimo_tab = precoRow?.preco_minimo != null ? round2(precoRow.preco_minimo) : null;
  if (!(preco_av_tabela > 0)) return j({ erro: "COMISSAO_FALHA_BUSCA_PRECO", mensagem: "Não foi possível obter o preço à vista de tabela do lote para a base da comissão." }, 502);
  const hojeISO = new Date().toISOString().slice(0, 10);
  const { data: promosAtivas } = await db
    .from("comercial_promocoes").select("id,empreendimento,data_inicio,data_fim,descricao");
  const vigentesPromo = (promosAtivas ?? []).filter((p) => {
    if (norm(p.empreendimento) !== alvo && norm(p.empreendimento) !== "todos") return false;
    if (!p.data_fim) return false;
    if (p.data_inicio && String(p.data_inicio).slice(0, 10) > hojeISO) return false;
    if (String(p.data_fim).slice(0, 10) < hojeISO) return false;
    return true;
  });
  const idsPromoAtiva = vigentesPromo.map((p) => p.id);
  const promo_descricao = String(vigentesPromo[0]?.descricao || "");
  let promoPrices = [];
  if (idsPromoAtiva.length) {
    const { data: promoPrecos } = await db
      .from("comercial_promocoes_precos").select("promocao_id,num_lote,empreendimento,preco_promocional").eq("num_lote", num_lote);
    promoPrices = (promoPrecos ?? [])
      .filter((p) => idsPromoAtiva.includes(p.promocao_id) && norm(p.empreendimento) === alvo)
      .map((p) => round2(p.preco_promocional)).filter((v) => v > 0);
  }
  const TOL = 0.01;
  const isAv = Math.abs(valor_lote_av - preco_av_tabela) < TOL;
  const isPromo = promoPrices.some((p) => Math.abs(valor_lote_av - p) < TOL);
  const ehAutonomia = preco_minimo_tab != null && preco_minimo_tab > 0 && !isAv && !isPromo;
  const base_comissao = ehAutonomia ? valor_lote_av : preco_av_tabela;

  let corretor = null;
  if (tem_corretor) {
    const busca = String(raw.corretor_busca ?? raw.nome_corretor ?? "").trim();
    if (!busca) return j({ erro: "CORRETOR_SEM_BUSCA", mensagem: "Informe CPF/CNPJ ou nome do corretor." }, 400);
    const { data: corrs } = await db.from("comercial_corretores").select("*");
    const bn = norm(busca);
    const bd = soDigitos(busca);
    corretor = (corrs ?? []).find((c) =>
      (bd && (soDigitos(c.cpf) === bd || soDigitos(c.cnpj) === bd)) || (bn.length >= 3 && norm(c.nome).includes(bn))
    ) ?? null;
    if (!corretor) return j({ erro: "CORRETOR_NAO_ENCONTRADO", mensagem: `Corretor "${busca}" não encontrado no cadastro.` }, 404);
  }

  const ov = (raw.corretor_override ?? {});
  const cget = (k) => { const o = String(ov?.[k] ?? "").trim(); return o || String(corretor?.[k] ?? "").trim(); };
  let dados_banco_cor = dadosBancariosCorretor(corretor);
  const bancoOv = String(ov?.dados_bancarios ?? "").trim();
  if (!dados_banco_cor && bancoOv) dados_banco_cor = bancoOv;
  const faltando = [];
  if (tem_corretor) {
    if (!cget("nome")) faltando.push("nome");
    if (!cget("cpf") && !cget("cnpj")) faltando.push("cpf");
    if (!cget("creci")) faltando.push("creci");
    if (!cget("endereco")) faltando.push("endereco");
    if (!cget("bairro")) faltando.push("bairro");
    if (!cget("cidade")) faltando.push("cidade");
    if (!cget("uf")) faltando.push("uf");
    if (!cget("cep")) faltando.push("cep");
    if (!cget("telefone")) faltando.push("telefone");
    if (!cget("email")) faltando.push("email");
    if (!dados_banco_cor) faltando.push("dados_bancarios");
  }
  if (gerar && faltando.length > 0) {
    return j({ erro: "CORRETOR_INCOMPLETO", mensagem: "Faltam dados do corretor pra montar o contrato. Preencha os campos indicados.", faltando }, 400);
  }

  const comissao_base = tem_corretor ? round2(base_comissao * 0.05) : 0;
  let bonificacao = 0;
  if (tem_corretor && bonus_solicitado > 0) {
    if (!perfil.pode_bonificar) return j({ erro: "BONIFICACAO_NEGADA_USUARIO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
    bonificacao = bonus_solicitado;
  }
  const honorarios = round2(comissao_base + bonificacao);

  // Entrada Young pode ser 0 no modo comissão parcelada (entrada toda virou honorários do corretor).
  // Fora desse modo, à prazo continua exigindo entrada > 0.
  if (tipo === "aprazo" && !comissaoParcelada && !(entrada_bruta > 0)) return j({ erro: "ENTRADA_ZERO", mensagem: "entrada_bruta veio zerada em contrato à prazo." }, 400);
  if (tipo === "aprazo" && entrada_bruta < 0) return j({ erro: "ENTRADA_NEGATIVA", mensagem: "Entrada Young não pode ser negativa." }, 400);
  if (tipo === "aprazo" && !(parcela > 0)) return j({ erro: "PARCELA_ZERO", mensagem: "parcela_mensal veio zerada em contrato à prazo." }, 400);
  const total_parcelas = tipo === "aprazo" ? round2(Number(raw.total_parcelas) || parcela * prazo) : 0;
  const parcela_final = (tipo === "aprazo" && prazo > 1) ? round2(total_parcelas - parcela * (prazo - 1)) : parcela;
  const total_reforcos = round2(reforcos.reduce((s, r) => s + r.valor, 0));

  // Validações do modo comissão parcelada + cronograma.
  let comissao_cronograma = null;
  if (comissaoParcelada && honorarios > 0) {
    if (entrada_corretor < 0) return j({ erro: "ENTRADA_CORRETOR_INVALIDA", mensagem: "Entrada do corretor inválida." });
    if (entrada_corretor > honorarios + 0.01) return j({ erro: "ENTRADA_CORRETOR_ALTA", mensagem: `A entrada do corretor (${fmt(entrada_corretor)}) não pode passar da comissão total (${fmt(honorarios)}).` });
    const resto_com = round2(honorarios - entrada_corretor);
    const soma_itens = round2(comissao_itens.reduce((s, r) => s + r.valor, 0));
    if (resto_com > 0.01 && Math.abs(soma_itens - resto_com) > 0.02) {
      return j({ erro: "COMISSAO_CRONOGRAMA", mensagem: `O parcelamento da comissão (${fmt(soma_itens)}) tem que fechar com o saldo da comissão (${fmt(resto_com)}).` });
    }
    comissao_cronograma = {
      total: honorarios,
      entrada_corretor,
      saldo: resto_com,
      itens: comissao_itens.map((x) => ({ data_str: x.data_str, valor: x.valor })),
    };
  }

  let preco_total, valor_imovel_31;
  if (tipo === "avista") {
    valor_imovel_31 = round2(entrada_bruta - honorarios);
    preco_total = round2(valor_imovel_31 + itbi_cartorio + honorarios);
  } else if (comissaoParcelada) {
    // MODO: entrada_bruta = Entrada Young. VALOR DO IMÓVEL = Entrada Young + reforços + parcelas − ITBI/registro
    // (NÃO desconta comissão — ela é à parte). PREÇO TOTAL inclui a comissão por cima.
    valor_imovel_31 = round2(entrada_bruta + total_reforcos + total_parcelas - itbi_cartorio);
    preco_total = round2(valor_imovel_31 + itbi_cartorio + honorarios);
  } else {
    preco_total = round2(entrada_bruta + total_reforcos + total_parcelas);
    valor_imovel_31 = round2(preco_total - honorarios - itbi_cartorio);
  }
  // Entrada que vai pra empresa: no modo, é a Entrada Young cheia (comissão não sai daqui).
  const entrada_liquida = comissaoParcelada ? entrada_bruta : round2(entrada_bruta - honorarios);
  if (valor_imovel_31 < 0) return j({ erro: "VALOR_IMOVEL_NEGATIVO", mensagem: `Valor do Imóvel calculado é negativo (${fmt(valor_imovel_31)}).` });
  // Trava "comissão maior que a entrada": NÃO se aplica no modo (comissão é à parte).
  if (tem_corretor && !comissaoParcelada && honorarios > entrada_bruta) return j({ erro: "HONORARIOS_ALTOS", mensagem: `Honorários (${fmt(honorarios)}) maiores que a entrada (${fmt(entrada_bruta)}).` });

  let item = 1;
  const linhas_valor = [];
  linhas_valor.push(`3.${item++} VALOR DO IMÓVEL: ${vf(valor_imovel_31)}`);
  linhas_valor.push(`3.${item++} CUSTOS DE ITBI E REGISTRO: ${vf(itbi_cartorio)}`);
  if (tem_corretor && honorarios > 0) linhas_valor.push(`3.${item++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA: ${vf(honorarios)}`);
  linhas_valor.push(`3.${item++} PREÇO TOTAL DO IMÓVEL: ${vf(preco_total)}`);
  const Valor_Imovel = linhas_valor.join("\n");

  let pg = 1;
  const linhas_pgto = [];
  if (tipo === "avista") {
    if (tem_corretor && honorarios > 0) {
      linhas_pgto.push(`4.${pg++} ${vf(round2(preco_total - honorarios))}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
      linhas_pgto.push(`4.${pg++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA de ${vf(honorarios)}, mediante transferência eletrônica diretamente pelo COMPRADOR(A,ES) ao beneficiário qualificado no Campo 11, para os dados bancários ${dados_banco_cor}`);
    } else {
      linhas_pgto.push(`4.${pg++} ${vf(preco_total)}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
    }
  } else {
    // Entrada Young = 0 (entrada toda virou honorários do corretor): NÃO escreve cláusula de entrada no contrato.
    if (entrada_liquida > 0) {
      linhas_pgto.push(`4.${pg++} ENTRADA de ${vf(entrada_liquida)}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
    }
    if (tem_corretor && honorarios > 0) {
      if (comissaoParcelada) {
        // Comissão paga à parte: entrada do corretor + saldo parcelado/numa data.
        let txt = `4.${pg++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA de ${vf(honorarios)}, pagos mediante transferência eletrônica diretamente pelo DEVEDOR(A,ES)/FIDUCIANTE(S) ao beneficiário qualificado no Campo 11 (dados bancários ${dados_banco_cor})`;
        const partesCom = [];
        if (entrada_corretor > 0) partesCom.push(`${vf(entrada_corretor)} na data de ${data_entrada}`);
        const saldoCom = round2(honorarios - entrada_corretor);
        if (saldoCom > 0.01 && comissao_itens.length) {
          const lista = comissao_itens.map((x) => `${vf(x.valor)} em ${x.data_str}`).join("; ");
          const plural = comissao_itens.length > 1 ? `${comissao_itens.length} parcelas` : "1 parcela";
          partesCom.push(`o saldo de ${vf(saldoCom)} em ${plural}, a saber: ${lista}`);
        }
        if (partesCom.length) txt += `, sendo ${partesCom.join(" e ")}`;
        txt += ".";
        linhas_pgto.push(txt);
      } else {
        linhas_pgto.push(`4.${pg++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA de ${vf(honorarios)}, mediante transferência eletrônica diretamente pelo DEVEDOR(A,ES)/FIDUCIANTE(S) ao beneficiário qualificado no Campo 11, para os dados bancários ${dados_banco_cor}`);
      }
    }
    if (reforcos.length > 0) {
      const lista = reforcos.map((r) => `${r.data_str}: ${vf(r.valor)}`).join("\n");
      linhas_pgto.push(`4.${pg++} REFORÇOS de ${vf(total_reforcos)}, através de boleto bancário, nas seguintes datas e valores:\n${lista}`);
    }
    if (prazo > 1 && Math.abs(parcela_final - parcela) >= 0.005) {
      linhas_pgto.push(`4.${pg++} SALDO de ${vf(total_parcelas)}, através de boleto bancário, em ${prazo} parcelas mensais e consecutivas, sendo as ${prazo - 1} primeiras no valor de ${vf(parcela)} cada e a última no valor de ${vf(parcela_final)}, a primeira com vencimento em ${data_prim_venc} e as demais nos meses subsequentes.`);
    } else {
      linhas_pgto.push(`4.${pg++} SALDO de ${vf(total_parcelas)}, através de boleto bancário, em ${prazo} parcelas mensais e consecutivas no valor de ${vf(parcela)}, sendo a primeira com vencimento em ${data_prim_venc} e as demais nos meses subsequentes.`);
    }
  }
  const Forma_de_Pagamento = linhas_pgto.join("\n");

  let Honorarios;
  if (tem_corretor && honorarios > 0) {
    Honorarios = `${vf(honorarios)} em favor de ${cget("nome")}, inscrito no CPF/CNPJ sob o nº ${cget("cpf") || cget("cnpj")}, CRECI ${cget("creci")}, com endereço na ${cget("endereco")}, ${cget("bairro")}, ${cget("cidade")}/${cget("uf")}, CEP ${cget("cep")}, fone ${cget("telefone")}, e-mail ${cget("email")}.`;
  } else {
    Honorarios = "A presente transação não é objeto de intermediação imobiliária.";
  }

  const comprador1 = String(raw.Comprador1 || "");
  const comprador2 = String(raw.Comprador2 || "");
  const nomes = comprador2 ? `${comprador1} e ${comprador2}` : comprador1;
  const condicao = tipo === "avista" ? "COMPRADOR(A,ES)" : "DEVEDOR(A,ES)/FIDUCIANTE(S)";
  const Final_Contrato = `de outro, ${nomes}, na condição de ${condicao}`;
  const Data_Assinatura = dataExtenso(new Date());

  const campos = {
    Qualificacao_Clientes: String(raw.Qualificacao_Clientes || ""),
    Valor_Imovel, Forma_de_Pagamento, Honorarios,
    Lote: num_lote, Area: area, Matricula: matricula, Onus: onusVal,
    Data_Assinatura, Comprador1: comprador1, Comprador2: comprador2,
    Final_Contrato,
  };
  const substituicoes = {
    "{{Qualificacao_Clientes}}": campos.Qualificacao_Clientes,
    "{{Valor_Imovel}}": campos.Valor_Imovel,
    "{{Forma_de_Pagamento}}": campos.Forma_de_Pagamento,
    "{{Honorarios}}": campos.Honorarios,
    "{{Lote}}": campos.Lote,
    "{{Area}}": campos.Area,
    "{{Matricula}}": campos.Matricula,
    "{{Onus}}": campos.Onus,
    "{{Data_Assinatura}}": campos.Data_Assinatura,
    "{{Data_Assinatrura}}": campos.Data_Assinatura,
    "{{Comprador1}}": campos.Comprador1,
    "{{Comprador2}}": campos.Comprador2,
    "{{Compradores}}": nomes,
    "{{Final_Contrato}}": campos.Final_Contrato,
    "{{Valor_Avaliacao}}": `${fmt(valor_imovel_31)} (${extenso(valor_imovel_31)})`,
  };
  const requests = Object.entries(substituicoes).map(([text, replaceText]) => ({
    replaceAllText: { containsText: { text, matchCase: true }, replaceText },
  }));

  if (gerar) {
    const reservaConfirmada = raw.reserva_confirmada === true || raw.reserva_confirmada === "true";
    if (reservaInfo.reservado && !reservaConfirmada) {
      const r = reserva ?? {};
      const quem = String(r.nome ?? "").trim() || "cliente não identificado";
      const tipoRes = String(r.tipo ?? "Reserva");
      const resp = String(r.responsavel_reserva ?? r.criado_por_email ?? "").trim();
      let quando = "";
      try { if (r.criado_em) quando = new Date(String(r.criado_em)).toLocaleDateString("pt-BR"); } catch { /* */ }
      const mensagem = `Lote ${num_lote} já está RESERVADO (${tipoRes}) em nome de ${quem}` +
        (foiVoce ? " — reserva feita por você" : (resp ? `, por ${resp}` : "")) +
        (quando ? ` em ${quando}` : "") + ". Confira antes de gerar o contrato.";
      return j({ requer_confirmacao: true, reservado: true, foi_voce: foiVoce, reserva: r, mensagem });
    }

    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!saJson) return j({ erro: "GOOGLE_NAO_CONFIGURADO", mensagem: "Falta cadastrar o segredo GOOGLE_SERVICE_ACCOUNT no Supabase (Edge Functions → Secrets)." }, 501);
    try {
      let saEmail = ""; try { saEmail = JSON.parse(saJson).client_email || ""; } catch { /* */ }
      const impersonar = Deno.env.get("CONTRATO_IMPERSONAR") || "";
      const token = await googleToken(saJson, impersonar || undefined);
      const dt = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const usuario = String(perfil.nome || user.email || "").replace(/[^A-Za-z0-9]/g, "");
      const empClean = empreendimento_input.replace(/[^A-Za-z0-9]/g, "");
      const nomeArquivo = `contratobot_${empClean}_${usuario}_${p2(dt.getDate())}${p2(dt.getMonth() + 1)}${dt.getFullYear()}_${num_lote}_${p2(dt.getHours())}${p2(dt.getMinutes())}${p2(dt.getSeconds())}`;
      const copyR = await fetch(`https://www.googleapis.com/drive/v3/files/${template_id}/copy?supportsAllDrives=true`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: nomeArquivo, parents: [PASTA_ID] }),
      });
      const copy = await copyR.json();
      if (!copy.id) { console.error("DRIVE_COPY", saEmail, template_id, PASTA_ID, JSON.stringify(copy)); return j({ erro: "DRIVE_COPY", conta_servico: saEmail, template_id, pasta: PASTA_ID, impersonando: impersonar || null, mensagem: `Falha ao gerar. Conta: ${saEmail || "?"}${impersonar ? " (impersonando " + impersonar + ")" : ""} · Template: ${template_id} · Pasta: ${PASTA_ID} · Google: ${JSON.stringify(copy?.error ?? copy).slice(0, 250)}`, detalhe: JSON.stringify(copy).slice(0, 400) }, 502); }
      const buR = await fetch(`https://docs.googleapis.com/v1/documents/${copy.id}:batchUpdate`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });
      const bu = await buR.json();
      if (bu.error) return j({ erro: "DOCS_UPDATE", mensagem: "Falha ao preencher o documento.", detalhe: JSON.stringify(bu.error).slice(0, 300) }, 502);

      const linkDoc = `https://docs.google.com/document/d/${copy.id}/edit`;
      const notificacoes = [];
      try {
        const { data: csGer } = await admin.rpc("get_status_lote", { p_nome: empreendimento_input, p_num: num_lote });
        const codGer = typeof csGer === "string" ? csGer : null;
        const sitGer = codGer ? (STATUS_LABEL[codGer] ?? "indisponível") : null;
        const usuarioGer = String(perfil.nome || user.email || "");
        const situacaoReg = (reservaInfo.reservado ? "reservado (Reservas)" : ((codGer && codGer !== "D") ? sitGer : null));
        const { error } = await db.from("simulador_notificacoes").insert({
          tipo: "contrato",
          empreendimento: empreendimento_input, num_lote, comprador: nomes,
          gerado_por: usuarioGer, link: linkDoc, entrada: entrada_bruta, prazo,
          valor_aplicado: valor_lote_av,
          situacao: situacaoReg,
          dados: {
            tipo_contrato: tipo,
            parcela: parcela,
            total_parcelas: total_parcelas,
            autonomia: ehAutonomia ? { preco_tabela: preco_av_tabela, preco_minimo: preco_minimo_tab } : null,
            promocao: isPromo ? (promo_descricao || true) : null,
            override: (codGer && codGer !== "D") ? sitGer : null,
            reserva: reservaInfo.reservado ? {
              tipo: String(reserva?.tipo ?? ""),
              cliente: String(reserva?.nome ?? ""),
              responsavel: String(reserva?.responsavel_reserva ?? reserva?.criado_por_email ?? ""),
              confirmada_por: usuarioGer,
            } : null,
            comissao_parcelada: comissaoParcelada ? { total: honorarios, entrada_corretor, saldo: round2(honorarios - entrada_corretor), parcelas: comissao_itens.length } : null,
            bonus: bonificacao > 0 ? { corretor: cget("nome") || null, comissao_base, bonificacao, comissao_total: honorarios } : null,
          },
        });
        notificacoes.push({ tipo: "contrato", ok: !error, erro: error?.message });
      } catch (e) { notificacoes.push({ tipo: "contrato", ok: false, erro: e instanceof Error ? e.message : String(e) }); }

      return j({ sucesso: true, gerado: true, documento_id: copy.id, link: linkDoc, nome_arquivo: nomeArquivo, proprietario, tem_corretor, comissao_cronograma, notificacoes });
    } catch (e) {
      return j({ erro: "GOOGLE_FALHA", mensagem: "Erro ao falar com o Google: " + (e instanceof Error ? e.message : String(e)) }, 502);
    }
  }

  return j({
    sucesso: true,
    tipo_contrato: tipo,
    tem_corretor,
    proprietario,
    template_id,
    dados_lote: { matricula, area, onus: onusVal },
    dados_banco_empresa: dados_banco_emp,
    corretor_nome: tem_corretor ? cget("nome") : null,
    dados_banco_corretor: dados_banco_cor,
    corretor_faltando: faltando,
    reservado: reservaInfo.reservado,
    foi_voce: foiVoce,
    reserva,
    comissao_cronograma,
    campos,
    requests,
    _calc: {
      base_comissao: fmt(base_comissao),
      base_origem: ehAutonomia ? "aplicado (autonomia)" : "preco_av tabela",
      comissao_base: fmt(comissao_base),
      bonificacao: fmt(bonificacao),
      honorarios: fmt(honorarios),
      entrada_liquida: fmt(entrada_liquida),
      entrada_corretor: fmt(entrada_corretor),
      itbi_cartorio: fmt(itbi_cartorio),
      total_parcelas: fmt(total_parcelas),
      parcela_final: fmt(parcela_final),
      total_reforcos: fmt(total_reforcos),
      preco_total: fmt(preco_total),
      valor_imovel_31: fmt(valor_imovel_31),
    },
  });
});
