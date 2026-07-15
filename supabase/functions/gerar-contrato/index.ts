import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// GERADOR DE CONTRATO — Young (port determinístico do n8n "Gerador de Contratos")
// Etapa 3a: monta os campos do contrato (cláusulas 3.x/4.x, honorários, vendedora,
// placeholders) de forma determinística e SEGURA. NÃO gera o Google Doc ainda
// (isso é a 3b, que depende dos segredos da service account).
// Segurança: exige usuário logado (verify_jwt) + allowlist; base da comissão e
// bônus validados no servidor (pode_bonificar), nunca por nome digitado.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function norm(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
const round2 = (v: unknown) => Math.round(Number(v) * 100) / 100;
const fmt = (v: unknown) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// valor por extenso (idêntico ao n8n)
function extenso(valor: number): string {
  const n = Math.round(Number(valor) * 100);
  const reais = Math.floor(n / 100);
  const centavos = n % 100;
  const unidades = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
  const dezenas = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const centenas = ["", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
  function grupo(x: number): string {
    const c = Math.floor(x / 100);
    const resto = x % 100;
    const d = Math.floor(resto / 10);
    const u = resto % 10;
    const parts: string[] = [];
    if (c > 0) { if (c === 1 && resto > 0) parts.push("cento"); else parts.push(centenas[c]); }
    if (resto >= 20) { parts.push(dezenas[d]); if (u > 0) parts.push(unidades[u]); }
    else if (resto > 0) parts.push(unidades[resto]);
    return parts.join(" e ");
  }
  function parteInteira(x: number): string {
    if (x === 0) return "zero";
    const bilhoes = Math.floor(x / 1_000_000_000);
    const milhoes = Math.floor((x % 1_000_000_000) / 1_000_000);
    const milhares = Math.floor((x % 1_000_000) / 1_000);
    const resto = x % 1_000;
    const parts: string[] = [];
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
const vf = (valor: number) => `R$ ${fmt(valor)} (${extenso(valor)})`;

const VENDEDORA: Record<string, string> = {
  young: "ITY  EMPREENDIMENTOS IMOBILIARIOS SPE LTDA., empresa brasileira, pessoa jurídica com sede na Rua Manduca Loureiro, s/n, bairro Cafifas em Itaqui – RS, inscrita no CNPJ n.º 52.675.236/0001-21, representada neste ato por EDUARDO PEREIRA TEBALDI, brasileiro, maior, empresário, inscrito no CPF/MF nº 004.999.680-00 e Carteira de Identidade nº 6080749929, expedida pela SSP-RS em 21/05/2015, residente e domiciliado na Rua Coronel Vicente Gomes, nº 467, apto 304, bairro Centro em Santo Antônio da Patrulha – RS, que convive em união estável em regime de separação total de bens com DANIELLE SOARES PORCIUNCULA, inscrita no CPF sob o nº 019.733.700-77 e Carteira de Identidade nº 2113422981, residente e domiciliada na Rua João Manoel Fernandes, nº 82, bairro Centro em Santo Antônio da Patrulha – RS.",
  horizonte: "HORIZONTE NEGOCIOS IMOBILIARIOS  LTDA., empresa brasileira, pessoa jurídica com sede na na cidade de Itaqui – RS, inscrita no CNPJ n.º 19.861.261/0001-24, representada neste ato por CARLA SILVEIRA DELLAMORA, brasileira, solteira, maior, arquiteta e urbanista, inscrita no CPF/MF nº 016.797.290-12 e Carteira Nacional de Habilitação nº 05424745517, expedida pela DETRAN-RS, residente e domiciliado na Rua Domingos Martins, nº 2021, bairro Cidade Alta em Itaqui – RS.",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return j({ erro: "METODO", mensagem: "Use POST." }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1) Identidade + allowlist
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return j({ erro: "NAO_AUTENTICADO", mensagem: "Login obrigatório." }, 401);
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user?.email) return j({ erro: "NAO_AUTENTICADO", mensagem: "Sessão inválida." }, 401);
  const { data: perfil } = await admin
    .from("simulador_usuarios").select("papel,pode_autonomia,pode_bonificar,ativo")
    .eq("email", user.email.toLowerCase()).maybeSingle();
  if (!perfil || !perfil.ativo) return j({ erro: "SEM_PERMISSAO", mensagem: "Acesso não liberado." }, 403);

  // 2) Entrada
  let raw: Record<string, unknown> = {};
  try { raw = await req.json(); } catch { return j({ erro: "ENTRADA", mensagem: "JSON inválido." }, 400); }

  const tipo = (String(raw.tipo_contrato || "aprazo")).toLowerCase(); // 'avista' | 'aprazo'
  const empreendimento_input = String(raw.empreendimento ?? "");
  const num_lote = raw.num_lote != null ? String(raw.num_lote) : String(raw.Lote ?? "");

  // Números financeiros (vêm da simulação já feita no servidor)
  const valor_lote_av = round2(raw.valor_lote_av || 0);
  const entrada_bruta = round2(raw.entrada_bruta ?? raw.entrada ?? 0);
  const parcela = round2(raw.parcela_mensal || 0);
  const prazo = parseInt(String(raw.prazo_meses || 0));
  const itbi = round2(raw.itbi || 0);
  const cartorio = round2(raw.cartorio ?? raw.cartorio_fixo ?? 0);
  const itbi_cartorio = round2(itbi + cartorio);
  const data_entrada = String(raw.data_entrada || "");
  const data_prim_venc = String(raw.data_primeiro_vencimento || "");
  const dados_banco_emp = String(raw.dados_bancarios_empresa || "");
  const reforcos = (Array.isArray(raw.reforcos) ? raw.reforcos as Array<Record<string, unknown>> : [])
    .map((r) => ({ valor: round2(r.valor || 0), data_str: String(r.data_str ?? r.data ?? "") }))
    .filter((r) => r.valor > 0);

  const tem_corretor = !!raw.tem_corretor;
  const bonus_solicitado = round2(raw.bonus_comissao ?? raw.bonus ?? 0);

  // 3) Base da comissão — do banco (service_role), como no n8n:
  //    autonomia (aplicado ≠ tabela e ≠ promo, lote com preço mínimo) → aplicado;
  //    senão → preço de tabela (promoção usa tabela).
  if (!num_lote || !empreendimento_input) {
    return j({ erro: "PARAMETRO_FALTANDO", mensagem: "empreendimento e num_lote (Lote) são obrigatórios para a base da comissão." }, 400);
  }
  const alvo = norm(empreendimento_input);

  // Template do contrato (por empreendimento × tipo × proprietário) — do banco.
  const { data: templates } = await admin
    .from("comercial_templates_contratos")
    .select("empreendimento,proprietario,id_doc_avista,id_doc_aprazo");
  const tRows = (templates ?? []).filter((t) => norm(t.empreendimento) === alvo);
  if (tRows.length === 0) return j({ erro: "TEMPLATE_NAO_ENCONTRADO", mensagem: `Sem template de contrato cadastrado para "${empreendimento_input}".` }, 404);
  let tRow = tRows[0];
  if (tRows.length > 1) {
    const propPed = norm(raw.proprietario || "");
    const achou = tRows.find((t) => norm(t.proprietario) === propPed);
    if (!achou) return j({ erro: "PROPRIETARIO_AMBIGUO", mensagem: "Este empreendimento tem mais de uma vendedora. Informe o proprietário.", opcoes: tRows.map((t) => t.proprietario) });
    tRow = achou;
  }
  const proprietario = norm(tRow.proprietario) === "horizonte" ? "horizonte" : "young";
  const template_id = tipo === "avista" ? (tRow.id_doc_avista || "") : (tRow.id_doc_aprazo || "");
  if (!template_id) return j({ erro: "TEMPLATE_TIPO_FALTANDO", mensagem: `Template ${tipo === "avista" ? "à vista" : "à prazo"} não cadastrado para "${empreendimento_input}".` }, 404);

  const { data: linhas } = await admin
    .from("comercial_tabela_precos").select("empreendimento,num_lote,preco_av,preco_minimo,created_at")
    .eq("num_lote", num_lote).order("created_at", { ascending: false });
  const precoRow = (linhas ?? []).find((l) => norm(l.empreendimento) === alvo);
  const preco_av_tabela = round2(precoRow?.preco_av || 0);
  const preco_minimo_tab = precoRow?.preco_minimo != null ? round2(precoRow.preco_minimo) : null;
  if (!(preco_av_tabela > 0)) {
    return j({ erro: "COMISSAO_FALHA_BUSCA_PRECO", mensagem: "Não foi possível obter o preço à vista de tabela do lote para a base da comissão." }, 502);
  }
  // preços promocionais do lote (para classificar promoção vs autonomia)
  const { data: promoPrecos } = await admin
    .from("comercial_promocoes_precos").select("num_lote,empreendimento,preco_promocional")
    .eq("num_lote", num_lote);
  const promoPrices = (promoPrecos ?? [])
    .filter((p) => norm(p.empreendimento) === alvo)
    .map((p) => round2(p.preco_promocional)).filter((v) => v > 0);

  const TOL = 0.01;
  const isAv = Math.abs(valor_lote_av - preco_av_tabela) < TOL;
  const isPromo = promoPrices.some((p) => Math.abs(valor_lote_av - p) < TOL);
  const elegivelAutonomia = preco_minimo_tab != null && preco_minimo_tab > 0;
  const ehAutonomia = elegivelAutonomia && !isAv && !isPromo;
  const base_comissao = ehAutonomia ? valor_lote_av : preco_av_tabela;

  // Honorários só existem com corretor (intermediação). Bônus só p/ pode_bonificar.
  const comissao_base = tem_corretor ? round2(base_comissao * 0.05) : 0;
  let bonificacao = 0;
  if (tem_corretor && bonus_solicitado > 0) {
    if (!perfil.pode_bonificar) return j({ erro: "BONIFICACAO_NEGADA_USUARIO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
    bonificacao = bonus_solicitado;
  }
  const honorarios = round2(comissao_base + bonificacao);

  // 4) Validações
  if (tipo === "aprazo" && entrada_bruta <= 0) return j({ erro: "ENTRADA_ZERO", mensagem: "entrada_bruta veio zerada em contrato à prazo." }, 400);
  if (tipo === "aprazo" && parcela <= 0) return j({ erro: "PARCELA_ZERO", mensagem: "parcela_mensal veio zerada em contrato à prazo." }, 400);

  const total_parcelas = tipo === "aprazo" ? round2(parcela * prazo) : 0;
  const total_reforcos = round2(reforcos.reduce((s, r) => s + r.valor, 0));

  let preco_total: number, valor_imovel_31: number;
  if (tipo === "avista") {
    valor_imovel_31 = round2(entrada_bruta - honorarios);
    preco_total = round2(valor_imovel_31 + itbi_cartorio + honorarios);
  } else {
    preco_total = round2(entrada_bruta + total_reforcos + total_parcelas);
    valor_imovel_31 = round2(preco_total - honorarios - itbi_cartorio);
  }
  const entrada_liquida = round2(entrada_bruta - honorarios);

  if (valor_imovel_31 < 0) return j({ erro: "VALOR_IMOVEL_NEGATIVO", mensagem: `Valor do Imóvel calculado é negativo (${fmt(valor_imovel_31)}). Verifique honorários e ITBI.` });
  if (tem_corretor && honorarios > entrada_bruta) return j({ erro: "HONORARIOS_ALTOS", mensagem: `Honorários (${fmt(honorarios)}) maiores que a entrada (${fmt(entrada_bruta)}).` });

  // 5) Campo 3.x — Valor do Imóvel
  let item = 1;
  const linhas_valor: string[] = [];
  linhas_valor.push(`3.${item++} VALOR DO IMÓVEL: ${vf(valor_imovel_31)}`);
  linhas_valor.push(`3.${item++} CUSTOS DE ITBI E REGISTRO: ${vf(itbi_cartorio)}`);
  if (tem_corretor && honorarios > 0) linhas_valor.push(`3.${item++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA: ${vf(honorarios)}`);
  linhas_valor.push(`3.${item++} PREÇO TOTAL DO IMÓVEL: ${vf(preco_total)}`);
  const Valor_Imovel = linhas_valor.join("\n");

  // 6) Campo 4.x — Forma de Pagamento
  let pg = 1;
  const linhas_pgto: string[] = [];
  const dados_banco_cor = String(raw.dados_bancarios_corretor || "");
  if (tipo === "avista") {
    if (tem_corretor && honorarios > 0) {
      linhas_pgto.push(`4.${pg++} ${vf(round2(preco_total - honorarios))}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
      linhas_pgto.push(`4.${pg++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA de ${vf(honorarios)}, mediante transferência eletrônica diretamente pelo COMPRADOR(A,ES) ao beneficiário qualificado no Campo 11, para os dados bancários ${dados_banco_cor}`);
    } else {
      linhas_pgto.push(`4.${pg++} ${vf(preco_total)}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
    }
  } else {
    linhas_pgto.push(`4.${pg++} ENTRADA de ${vf(entrada_liquida)}, através de transferência bancária, até a data de ${data_entrada} em favor da CREDORA/FIDUCIÁRIA, ${dados_banco_emp}`);
    if (tem_corretor && honorarios > 0) {
      linhas_pgto.push(`4.${pg++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA de ${vf(honorarios)}, mediante transferência eletrônica diretamente pelo DEVEDOR(A,ES)/FIDUCIANTE(S) ao beneficiário qualificado no Campo 11, para os dados bancários ${dados_banco_cor}`);
    }
    if (reforcos.length > 0) {
      const lista = reforcos.map((r) => `${r.data_str}: ${vf(r.valor)}`).join("\n");
      linhas_pgto.push(`4.${pg++} REFORÇOS de ${vf(total_reforcos)}, através de boleto bancário, nas seguintes datas e valores:\n${lista}`);
    }
    linhas_pgto.push(`4.${pg++} SALDO de ${vf(total_parcelas)}, através de boleto bancário, em ${prazo} parcelas mensais e consecutivas no valor de ${vf(parcela)}, sendo a primeira com vencimento em ${data_prim_venc} e as demais nos meses subsequentes.`);
  }
  const Forma_de_Pagamento = linhas_pgto.join("\n");

  // 7) Campo 11 — Honorários
  let Honorarios: string;
  if (tem_corretor && honorarios > 0) {
    Honorarios = `${vf(honorarios)} em favor de ${raw.nome_corretor || ""}, inscrito no CPF/CNPJ sob o nº ${raw.doc_corretor || ""}, CRECI ${raw.creci_corretor || ""}, com endereço na ${raw.endereco_corretor || ""}, ${raw.bairro_corretor || ""}, ${raw.cidade_corretor || ""}/${raw.uf_corretor || ""}, CEP ${raw.cep_corretor || ""}, fone ${raw.telefone_corretor || ""}, e-mail ${raw.email_corretor || ""}.`;
  } else {
    Honorarios = "A presente transação não é objeto de intermediação imobiliária.";
  }

  // 8) Demais placeholders
  const comprador1 = String(raw.Comprador1 || "");
  const comprador2 = String(raw.Comprador2 || "");
  const nomes = comprador2 ? `${comprador1} e ${comprador2}` : comprador1;
  const condicao = tipo === "avista" ? "COMPRADOR(A,ES)" : "DEVEDOR(A,ES)/FIDUCIANTE(S)";
  const Final_Contrato = `de outro, ${nomes}, na condição de ${condicao}`;
  const Qualificacao_Vendedora = VENDEDORA[proprietario];
  const onus = (raw.Onus === "N" || raw.Onus === "n") ? "Não há." : String(raw.Onus || "");

  const campos: Record<string, string> = {
    Qualificacao_Clientes: String(raw.Qualificacao_Clientes || ""),
    Valor_Imovel, Forma_de_Pagamento, Honorarios,
    Lote: String(raw.Lote ?? num_lote),
    Area: String(raw.Area || ""),
    Matricula: String(raw.Matricula || ""),
    Onus: onus,
    Data_Assinatura: String(raw.Data_Assinatura || ""),
    Comprador1: comprador1, Comprador2: comprador2,
    Final_Contrato, Qualificacao_Vendedora,
  };
  // Mapa placeholder → valor (inclui o typo do template)
  const substituicoes: Record<string, string> = {
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
    "{{Final_Contrato}}": campos.Final_Contrato,
    "{{Qualificacao_Vendedora}}": campos.Qualificacao_Vendedora,
  };
  const requests = Object.entries(substituicoes).map(([text, replaceText]) => ({
    replaceAllText: { containsText: { text, matchCase: true }, replaceText },
  }));

  return j({
    sucesso: true,
    tipo_contrato: tipo,
    tem_corretor,
    proprietario,
    template_id,
    campos,
    requests,
    _calc: {
      base_comissao: fmt(base_comissao),
      base_origem: ehAutonomia ? "aplicado (autonomia)" : "preco_av tabela",
      comissao_base: fmt(comissao_base),
      bonificacao: fmt(bonificacao),
      honorarios: fmt(honorarios),
      entrada_liquida: fmt(entrada_liquida),
      itbi_cartorio: fmt(itbi_cartorio),
      total_parcelas: fmt(total_parcelas),
      total_reforcos: fmt(total_reforcos),
      preco_total: fmt(preco_total),
      valor_imovel_31: fmt(valor_imovel_31),
      check_fechamento: fmt(round2(valor_imovel_31 + honorarios + itbi_cartorio + total_parcelas + total_reforcos)),
    },
  });
});
