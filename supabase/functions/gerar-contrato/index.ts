import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// GERADOR DE CONTRATO — Young (port determinístico do n8n "Gerador de Contratos")
// Etapa 3a: monta os campos do contrato (cláusulas 3.x/4.x, honorários, vendedora,
// placeholders) de forma determinística e SEGURA. Puxa do banco (service_role) o
// que o bot buscava — matrícula/área/ônus/proprietário, dados bancários e corretor —
// em vez de pedir pro usuário digitar. NÃO gera o Google Doc ainda (3b).
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
const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const dataExtenso = (d: Date) => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PASTA_ID = Deno.env.get("CONTRATO_PASTA_ID") || "18W0BBrWOIhfAz1eGfDi1itly-KZl5ULF";

// ── Google (conta de serviço): JWT RS256 -> access_token ──
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const clean = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function googleToken(saJson: string): Promise<string> {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}` });
  const t = await r.json();
  if (!t.access_token) throw new Error("token: " + JSON.stringify(t).slice(0, 200));
  return t.access_token;
}

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
    .from("simulador_usuarios").select("nome,papel,pode_autonomia,pode_bonificar,ativo")
    .eq("email", user.email.toLowerCase()).maybeSingle();
  if (!perfil || !perfil.ativo) return j({ erro: "SEM_PERMISSAO", mensagem: "Acesso não liberado." }, 403);

  // 2) Entrada (só o que é humano; o resto vem do banco)
  let raw: Record<string, unknown> = {};
  try { raw = await req.json(); } catch { return j({ erro: "ENTRADA", mensagem: "JSON inválido." }, 400); }

  const tipo = String(raw.tipo_contrato || "aprazo").toLowerCase(); // 'avista' | 'aprazo'
  const empreendimento_input = String(raw.empreendimento ?? "");
  const num_lote = raw.num_lote != null ? String(raw.num_lote) : String(raw.Lote ?? "");
  if (!num_lote || !empreendimento_input) return j({ erro: "PARAMETRO_FALTANDO", mensagem: "empreendimento e num_lote são obrigatórios." }, 400);
  const alvo = norm(empreendimento_input);

  // números financeiros (da simulação)
  const valor_lote_av = round2(raw.valor_lote_av || 0);
  const entrada_bruta = round2(raw.entrada_bruta ?? raw.entrada ?? 0);
  const parcela = round2(raw.parcela_mensal || 0);
  const prazo = parseInt(String(raw.prazo_meses || 0));
  const itbi = round2(raw.itbi || 0);
  const cartorio = round2(raw.cartorio ?? raw.cartorio_fixo ?? 0);
  const itbi_cartorio = round2(itbi + cartorio);
  const data_entrada = String(raw.data_entrada || "");
  const data_prim_venc = String(raw.data_primeiro_vencimento || "");
  const reforcos = (Array.isArray(raw.reforcos) ? raw.reforcos as Array<Record<string, unknown>> : [])
    .map((r) => ({ valor: round2(r.valor || 0), data_str: String(r.data_str ?? r.data ?? "") }))
    .filter((r) => r.valor > 0);

  const tem_corretor = !!raw.tem_corretor;
  const bonus_solicitado = round2(raw.bonus_comissao ?? raw.bonus ?? 0);

  // 3) Dados cadastrais do lote (matrícula/área/ônus/PROPRIETÁRIO) — comercial_lotes_detalhes
  const { data: dets } = await admin
    .from("comercial_lotes_detalhes")
    .select("empreendimento,num_lote,matricula,area,onus,proprietario")
    .eq("num_lote", num_lote);
  const det = (dets ?? []).find((d) => norm(d.empreendimento) === alvo);
  if (!det) return j({ erro: "LOTE_DETALHES_NAO_ENCONTRADO", mensagem: `Sem dados cadastrais (matrícula/área/proprietário) para o lote ${num_lote} de "${empreendimento_input}".` }, 404);
  const proprietario = norm(det.proprietario) === "horizonte" ? "horizonte" : "young";
  const matricula = String(det.matricula ?? "");
  const area = String(det.area ?? "");
  const onusVal = (det.onus == null || String(det.onus).trim() === "" || norm(det.onus) === "n") ? "Não há." : String(det.onus);

  // 4) Template (por empreendimento + proprietário + tipo) — comercial_templates_contratos
  const { data: templates } = await admin
    .from("comercial_templates_contratos")
    .select("empreendimento,proprietario,id_doc_avista,id_doc_aprazo");
  const tRow = (templates ?? []).find((t) => norm(t.empreendimento) === alvo && norm(t.proprietario) === proprietario)
    ?? (templates ?? []).find((t) => norm(t.empreendimento) === alvo);
  const template_id = tRow ? (tipo === "avista" ? (tRow.id_doc_avista || "") : (tRow.id_doc_aprazo || "")) : "";
  if (!template_id) return j({ erro: "TEMPLATE_NAO_ENCONTRADO", mensagem: `Template ${tipo === "avista" ? "à vista" : "à prazo"} não cadastrado para "${empreendimento_input}" (${proprietario}).` }, 404);

  // 5) Dados bancários da empresa (CREDORA) — comercial_dados_bancarios
  const { data: dbs } = await admin
    .from("comercial_dados_bancarios").select("empreendimento,dados_bancarios,proprietario");
  const dbRow = (dbs ?? []).find((x) => norm(x.empreendimento) === alvo && norm(x.proprietario) === proprietario);
  const dados_banco_emp = String(dbRow?.dados_bancarios ?? "");

  // 6) Base da comissão — comercial_tabela_precos (autonomia → aplicado; senão tabela)
  const { data: linhas } = await admin
    .from("comercial_tabela_precos").select("empreendimento,num_lote,preco_av,preco_minimo,created_at")
    .eq("num_lote", num_lote).order("created_at", { ascending: false });
  const precoRow = (linhas ?? []).find((l) => norm(l.empreendimento) === alvo);
  const preco_av_tabela = round2(precoRow?.preco_av || 0);
  const preco_minimo_tab = precoRow?.preco_minimo != null ? round2(precoRow.preco_minimo) : null;
  if (!(preco_av_tabela > 0)) return j({ erro: "COMISSAO_FALHA_BUSCA_PRECO", mensagem: "Não foi possível obter o preço à vista de tabela do lote para a base da comissão." }, 502);
  const { data: promoPrecos } = await admin
    .from("comercial_promocoes_precos").select("num_lote,empreendimento,preco_promocional").eq("num_lote", num_lote);
  const promoPrices = (promoPrecos ?? []).filter((p) => norm(p.empreendimento) === alvo).map((p) => round2(p.preco_promocional)).filter((v) => v > 0);
  const TOL = 0.01;
  const isAv = Math.abs(valor_lote_av - preco_av_tabela) < TOL;
  const isPromo = promoPrices.some((p) => Math.abs(valor_lote_av - p) < TOL);
  const ehAutonomia = preco_minimo_tab != null && preco_minimo_tab > 0 && !isAv && !isPromo;
  const base_comissao = ehAutonomia ? valor_lote_av : preco_av_tabela;

  // 7) Corretor (intermediação) — comercial_corretores por CPF/CNPJ/nome
  let corretor: Record<string, unknown> | null = null;
  if (tem_corretor) {
    const busca = String(raw.corretor_busca ?? raw.nome_corretor ?? "").trim();
    if (!busca) return j({ erro: "CORRETOR_SEM_BUSCA", mensagem: "Informe CPF/CNPJ ou nome do corretor." }, 400);
    const { data: corrs } = await admin.from("comercial_corretores").select("*");
    const bn = norm(busca);
    const bd = soDigitos(busca);
    corretor = (corrs ?? []).find((c) =>
      (bd && (soDigitos(c.cpf) === bd || soDigitos(c.cnpj) === bd)) || (bn.length >= 3 && norm(c.nome).includes(bn))
    ) ?? null;
    if (!corretor) return j({ erro: "CORRETOR_NAO_ENCONTRADO", mensagem: `Corretor "${busca}" não encontrado no cadastro.` }, 404);
  }

  // 8) Honorários (só com corretor). Bônus só p/ pode_bonificar.
  const comissao_base = tem_corretor ? round2(base_comissao * 0.05) : 0;
  let bonificacao = 0;
  if (tem_corretor && bonus_solicitado > 0) {
    if (!perfil.pode_bonificar) return j({ erro: "BONIFICACAO_NEGADA_USUARIO", mensagem: "Seu usuário não pode aplicar bonificação." }, 403);
    bonificacao = bonus_solicitado;
  }
  const honorarios = round2(comissao_base + bonificacao);

  // 9) Validações + cálculo das cláusulas
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
  if (valor_imovel_31 < 0) return j({ erro: "VALOR_IMOVEL_NEGATIVO", mensagem: `Valor do Imóvel calculado é negativo (${fmt(valor_imovel_31)}).` });
  if (tem_corretor && honorarios > entrada_bruta) return j({ erro: "HONORARIOS_ALTOS", mensagem: `Honorários (${fmt(honorarios)}) maiores que a entrada (${fmt(entrada_bruta)}).` });

  // Campo 3.x — Valor do Imóvel
  let item = 1;
  const linhas_valor: string[] = [];
  linhas_valor.push(`3.${item++} VALOR DO IMÓVEL: ${vf(valor_imovel_31)}`);
  linhas_valor.push(`3.${item++} CUSTOS DE ITBI E REGISTRO: ${vf(itbi_cartorio)}`);
  if (tem_corretor && honorarios > 0) linhas_valor.push(`3.${item++} HONORÁRIOS DE INTERMEDIAÇÃO IMOBILIÁRIA: ${vf(honorarios)}`);
  linhas_valor.push(`3.${item++} PREÇO TOTAL DO IMÓVEL: ${vf(preco_total)}`);
  const Valor_Imovel = linhas_valor.join("\n");

  // Campo 4.x — Forma de Pagamento
  let pg = 1;
  const linhas_pgto: string[] = [];
  const dados_banco_cor = String(corretor?.dados_bancarios ?? "");
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

  // Campo 11 — Honorários (corretor do banco)
  let Honorarios: string;
  if (tem_corretor && honorarios > 0 && corretor) {
    Honorarios = `${vf(honorarios)} em favor de ${corretor.nome ?? ""}, inscrito no CPF/CNPJ sob o nº ${corretor.cpf || corretor.cnpj || ""}, CRECI ${corretor.creci ?? ""}, com endereço na ${corretor.endereco ?? ""}, ${corretor.bairro ?? ""}, ${corretor.cidade ?? ""}/${corretor.uf ?? ""}, CEP ${corretor.cep ?? ""}, fone ${corretor.telefone ?? ""}, e-mail ${corretor.email ?? ""}.`;
  } else {
    Honorarios = "A presente transação não é objeto de intermediação imobiliária.";
  }

  // Demais placeholders
  const comprador1 = String(raw.Comprador1 || "");
  const comprador2 = String(raw.Comprador2 || "");
  const nomes = comprador2 ? `${comprador1} e ${comprador2}` : comprador1;
  const condicao = tipo === "avista" ? "COMPRADOR(A,ES)" : "DEVEDOR(A,ES)/FIDUCIANTE(S)";
  const Final_Contrato = `de outro, ${nomes}, na condição de ${condicao}`;
  const Data_Assinatura = dataExtenso(new Date());

  // A VENDEDORA/EMPRESA já vem escrita em cada template (um por empreendimento);
  // por isso NÃO substituímos {{Qualificacao_Vendedora}} — deixamos o template.
  const campos: Record<string, string> = {
    Qualificacao_Clientes: String(raw.Qualificacao_Clientes || ""),
    Valor_Imovel, Forma_de_Pagamento, Honorarios,
    Lote: num_lote, Area: area, Matricula: matricula, Onus: onusVal,
    Data_Assinatura, Comprador1: comprador1, Comprador2: comprador2,
    Final_Contrato,
  };
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
  };
  const requests = Object.entries(substituicoes).map(([text, replaceText]) => ({
    replaceAllText: { containsText: { text, matchCase: true }, replaceText },
  }));

  // 3b) Gerar o documento no Google Docs (se solicitado)
  if (raw.gerar === true || raw.gerar === "true") {
    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!saJson) return j({ erro: "GOOGLE_NAO_CONFIGURADO", mensagem: "Falta cadastrar o segredo GOOGLE_SERVICE_ACCOUNT no Supabase (Edge Functions → Secrets)." }, 501);
    try {
      const token = await googleToken(saJson);
      const dt = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const usuario = String(perfil.nome || user.email || "").replace(/[^A-Za-z0-9]/g, "");
      const empClean = empreendimento_input.replace(/[^A-Za-z0-9]/g, "");
      const nomeArquivo = `contratobot_${empClean}_${usuario}_${p2(dt.getDate())}${p2(dt.getMonth() + 1)}${dt.getFullYear()}_${num_lote}_${p2(dt.getHours())}${p2(dt.getMinutes())}${p2(dt.getSeconds())}`;
      // (1) COPIAR o template (sem pasta) — isola acesso ao TEMPLATE + APIs
      const copyR = await fetch(`https://www.googleapis.com/drive/v3/files/${template_id}/copy?supportsAllDrives=true`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: nomeArquivo }),
      });
      const copy = await copyR.json();
      if (!copy.id) return j({ erro: "COPY_TEMPLATE", etapa: "1-copiar-template", mensagem: "Falhou ao COPIAR o template. Causa: a conta de serviço não tem acesso ao Doc do template, OU as APIs (Drive/Docs) não estão ativadas no projeto da conta.", detalhe: JSON.stringify(copy).slice(0, 400) }, 502);
      // (2) MOVER a cópia para a pasta de destino — isola o Editor na PASTA
      const mvR = await fetch(`https://www.googleapis.com/drive/v3/files/${copy.id}?addParents=${PASTA_ID}&supportsAllDrives=true`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const mv = await mvR.json();
      if (mv.error) return j({ erro: "MOVE_PASTA", etapa: "2-mover-pasta", mensagem: "O template FOI copiado, mas falhou ao mover para a pasta de destino. Causa: a conta de serviço precisa de EDITOR na pasta.", detalhe: JSON.stringify(mv.error).slice(0, 400), documento_id: copy.id, link: `https://docs.google.com/document/d/${copy.id}/edit` }, 502);
      const buR = await fetch(`https://docs.googleapis.com/v1/documents/${copy.id}:batchUpdate`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });
      const bu = await buR.json();
      if (bu.error) return j({ erro: "DOCS_UPDATE", mensagem: "Falha ao preencher o documento.", detalhe: JSON.stringify(bu.error).slice(0, 300) }, 502);
      return j({ sucesso: true, gerado: true, documento_id: copy.id, link: `https://docs.google.com/document/d/${copy.id}/edit`, nome_arquivo: nomeArquivo, proprietario, tem_corretor });
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
    // devolve o que foi puxado do banco, pra conferência no front
    dados_lote: { matricula, area, onus: onusVal },
    dados_banco_empresa: dados_banco_emp,
    corretor_nome: corretor ? String(corretor.nome ?? "") : null,
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
    },
  });
});
