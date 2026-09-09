"use client";
/**
 * CelebracaoVenda — som + efeito visual quando alguém marca uma venda no Pingolead.
 *
 * Como funciona: o gatilho `trg_celebrar_venda` (crm.crm_deals → status 'vendido') grava uma
 * linha em `public.vendas_celebracao`. Este componente assina a tabela via Supabase Realtime
 * (INSERT) e, a cada linha nova, mostra um cartão com confete e toca uma fanfarra curta.
 *
 * Uso (qualquer app React — Vite, Next, TanStack): monte UMA vez na raiz.
 *   <CelebracaoVenda supabase={supabase} />
 * Ou, sem client pronto (ex.: Next server layout passa url/chave):
 *   <CelebracaoVenda url={SUPABASE_URL} anonKey={SUPABASE_ANON_KEY} />
 *
 * Sem dependências além de react e @supabase/supabase-js. Estilos inline (não depende do
 * Tailwind/tema do app). O som é sintetizado (Web Audio), sem arquivo de áudio.
 * Navegadores só tocam som depois de um clique/tecla na página — o efeito visual aparece sempre.
 * Botão 🔇 no cartão silencia o som só nesse navegador (localStorage).
 */
import { useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type VendaCelebracao = {
  id: number;
  deal_id: string;
  empreendimento: string | null;
  numero_lote: string | null;
  preco_lote: number | string | null;
  consultor_nome: string | null;
  corretor_nome: string | null;
  venda_externa: boolean;
  created_at: string;
};

type Props = {
  /** Client Supabase já existente no app (preferido). */
  supabase?: Pick<SupabaseClient<any, any, any>, "channel" | "removeChannel">;
  /** Alternativa: cria um client só p/ o Realtime (chave anon). */
  url?: string;
  anonKey?: string;
  /** Modo SEM chave no front: função que consulta vendas novas (ex.: Edge Function
   *  autenticada). Quando passada, é usada no lugar do Realtime/anon. */
  poll?: (sinceId: number | null) => Promise<{ latestId: number; novas: VendaCelebracao[] }>;
  /** Intervalo do poll em ms (só no modo poll). Padrão 12000. */
  intervaloMs?: number;
  /** Quantos segundos o cartão fica na tela. Padrão 10 (decisão Elen 2026-09-09). */
  duracaoSegundos?: number;
  /** Nome do sistema, só p/ o rótulo do cartão. */
  sistema?: string;
  /** URL de um arquivo de áudio (mp3/ogg) p/ tocar no lugar do som sintetizado. Ex.: "/sons/venda.mp3" na pasta public do app. */
  somUrl?: string;
  /** Volume do arquivo de áudio, 0 a 1. Padrão 1. */
  volume?: number;
  /** Quantas vezes o arquivo de áudio toca em sequência. Padrão 2. */
  repeticoesSom?: number;
};

const MUTE_KEY = "celebracao_venda_mudo";
const CLAIM_PREFIX = "celebracao_venda_claim_";

// ---------- Som (Web Audio, sintetizado) ----------
let audioCtx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}
// Desbloqueia o áudio no 1º gesto do usuário (política de autoplay dos navegadores).
function armarDesbloqueio() {
  if (typeof window === "undefined") return () => {};
  const unlock = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  const evs = ["pointerdown", "keydown", "touchstart"] as const;
  evs.forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  return () => evs.forEach((e) => window.removeEventListener(e, unlock));
}
function tocarFanfarra() {
  const ctx = getCtx();
  if (!ctx) return;
  const go = () => {
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);

    const noiseBuf = (() => {
      const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return b;
    })();
    const env = (g: GainNode, t: number, a: number, dur: number, vol: number) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    };
    // Tom simples
    const tom = (tipo: OscillatorType, f: number, t: number, dur: number, vol: number, detune = 0, slideTo?: number) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = tipo; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      env(g, t, 0.015, dur, vol);
      o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
    };
    // "Metal" (naipe): 3 dentes-de-serra desafinados + filtro que abre no ataque
    const metal = (f: number, t: number, dur: number, vol: number) => {
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.Q.value = 1.2;
      fl.frequency.setValueAtTime(600, t); fl.frequency.exponentialRampToValueAtTime(4500, t + 0.06);
      fl.frequency.exponentialRampToValueAtTime(1500, t + dur);
      const g = ctx.createGain(); env(g, t, 0.03, dur, vol);
      fl.connect(g).connect(master);
      [-9, 0, 9].forEach((d) => {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = d;
        o.connect(fl); o.start(t); o.stop(t + dur + 0.05);
      });
    };
    // Ruído filtrado (bateria / torcida)
    const ruido = (t: number, dur: number, vol: number, tipo: BiquadFilterType, fq: number, q: number, a = 0.005, sweepTo?: number) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const fl = ctx.createBiquadFilter(); fl.type = tipo; fl.Q.value = q; fl.frequency.setValueAtTime(fq, t);
      if (sweepTo) fl.frequency.linearRampToValueAtTime(sweepTo, t + dur);
      const g = ctx.createGain(); env(g, t, a, dur, vol);
      s.connect(fl).connect(g).connect(master); s.start(t); s.stop(t + dur + 0.05);
    };
    const bumbo = (t: number) => { tom("sine", 160, t, 0.35, 0.9, 0, 45); ruido(t, 0.05, 0.25, "lowpass", 900, 0.7); };
    const caixa = (t: number) => { ruido(t, 0.16, 0.5, "highpass", 1800, 0.6); tom("triangle", 190, t, 0.1, 0.35); };

    // 1) Rufar + subida de tensão
    for (let i = 0; i < 8; i++) caixa(t0 + i * 0.055);
    bumbo(t0); bumbo(t0 + 0.22);
    tom("sawtooth", 180, t0, 0.5, 0.12, 0, 1400);
    ruido(t0, 0.5, 0.35, "bandpass", 400, 1.5, 0.05, 5000);

    // 2) Cha-ching da caixa registradora
    [[2637, 0.5], [3520, 0.6], [4186, 0.66]].forEach(([f, dt]) => tom("sine", f, t0 + dt, 0.5, 0.3));

    // 3) Fanfarra de metais: TA - TA - TA - TAAAA (G4 G4 G4 → C5) + acorde final
    const F = 0.72;
    [[392, 0], [392, 0.16], [392, 0.32]].forEach(([f, dt]) => { metal(f, t0 + F + dt, 0.15, 0.5); bumbo(t0 + F + dt); });
    const acorde = t0 + F + 0.5;
    bumbo(acorde); caixa(acorde);
    ruido(acorde, 1.6, 0.35, "bandpass", 8000, 0.8, 0.01); // prato
    [[523.25, 0.55], [659.25, 0.42], [783.99, 0.42], [1046.5, 0.3], [261.63, 0.5], [130.81, 0.45]]
      .forEach(([f, v]) => metal(f, acorde, 1.9, v));
    // arpejo rápido por cima
    [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093].forEach((f, i) => tom("triangle", f, acorde + 0.05 + i * 0.045, 0.35, 0.22));

    // 4) Torcida vibrando + apitos
    const T = acorde + 0.05;
    ruido(T, 2.4, 0.55, "bandpass", 700, 0.5, 0.25, 1400);
    ruido(T + 0.1, 2.2, 0.35, "bandpass", 1800, 0.7, 0.3, 2600);
    for (let i = 0; i < 6; i++) {
      const dt = T + 0.15 + Math.random() * 1.4;
      tom("sine", 1400 + Math.random() * 600, dt, 0.25, 0.09, 0, 2600 + Math.random() * 800);
    }
    // 5) Brilhos aleatórios durante o acorde
    for (let i = 0; i < 14; i++) {
      const dt = acorde + 0.2 + Math.random() * 1.5;
      tom("sine", 2000 + Math.random() * 3000, dt, 0.18, 0.07);
    }
    // 6) Fecho: bumbo + prato
    bumbo(acorde + 1.9); ruido(acorde + 1.9, 1.2, 0.3, "highpass", 6000, 0.7, 0.01);
  };
  if (ctx.state === "suspended") ctx.resume().then(go).catch(() => {});
  else go();
}

// Toca o arquivo de áudio se houver; senão, o som sintetizado.
function tocarSom(somUrl?: string, volume = 1, repeticoes = 2) {
  if (!somUrl) return tocarFanfarra();
  try {
    const a = new Audio(somUrl);
    a.volume = Math.max(0, Math.min(1, volume));
    let restantes = Math.max(1, repeticoes) - 1;
    a.addEventListener("ended", () => { if (restantes-- > 0) { a.currentTime = 0; a.play().catch(() => {}); } });
    a.play().catch(() => tocarFanfarra());
  } catch {
    tocarFanfarra();
  }
}

// ---------- Confete (canvas) ----------
function soltarConfete(canvas: HTMLCanvasElement, duracaoMs: number) {
  const c = canvas.getContext("2d");
  if (!c) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();
  window.addEventListener("resize", resize);
  const cores = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#a855f7", "#facc15", "#ffffff"];
  const W = () => canvas.width, H = () => canvas.height;
  type P = { x: number; y: number; vx: number; vy: number; r: number; cor: string; ang: number; va: number; forma: number };
  const ps: P[] = [];
  const spawn = (n: number, x: number, dir: number) => {
    for (let i = 0; i < n; i++) {
      const a = (-Math.PI / 2) + dir * (Math.random() * 0.6) + (Math.random() - 0.5) * 0.5;
      const v = (9 + Math.random() * 13) * dpr;
      ps.push({ x, y: H() * 0.9, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: (4 + Math.random() * 5) * dpr,
        cor: cores[(Math.random() * cores.length) | 0], ang: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3, forma: Math.random() < 0.5 ? 0 : 1 });
    }
  };
  spawn(140, W() * 0.08, 1);
  spawn(140, W() * 0.92, -1);
  const t1 = performance.now() + duracaoMs;
  let raf = 0;
  const tick = () => {
    c.clearRect(0, 0, W(), H());
    const now = performance.now();
    if (now < t1 - 2500 && Math.random() < 0.35) spawn(6, Math.random() * W(), 0);
    for (const p of ps) {
      p.vy += 0.32 * dpr; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.ang += p.va;
      c.save(); c.translate(p.x, p.y); c.rotate(p.ang); c.fillStyle = p.cor;
      if (p.forma) c.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      else { c.beginPath(); c.arc(0, 0, p.r / 2, 0, Math.PI * 2); c.fill(); }
      c.restore();
    }
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].y > H() + 40) ps.splice(i, 1);
    if (now < t1 || ps.length) raf = requestAnimationFrame(tick);
    else c.clearRect(0, 0, W(), H());
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
}

// ---------- Utilidades ----------
function brl(v: number | string | null) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n == null || isNaN(n)) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function lerMudo() { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } }
function gravarMudo(v: boolean) { try { localStorage.setItem(MUTE_KEY, v ? "1" : "0"); } catch {} }
// Com várias abas do mesmo app abertas, só a 1ª que "reivindicar" o evento toca o som.
function reivindicarSom(id: number) {
  try {
    const k = CLAIM_PREFIX + id;
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, String(Date.now()));
    // limpeza de claims antigos
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CLAIM_PREFIX) && key !== k) {
        const t = Number(localStorage.getItem(key));
        if (!t || Date.now() - t > 3600_000) localStorage.removeItem(key);
      }
    }
    return true;
  } catch { return true; }
}

// ---------- Componente ----------
export default function CelebracaoVenda({ supabase, url, anonKey, poll, intervaloMs = 12000, duracaoSegundos = 10, sistema, somUrl, volume = 1, repeticoesSom = 2 }: Props) {
  const [venda, setVenda] = useState<VendaCelebracao | null>(null);
  const [mudo, setMudo] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fila = useRef<VendaCelebracao[]>([]);
  const mostrando = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pararConfete = useRef<() => void>(() => {});

  useEffect(() => { setMudo(lerMudo()); return armarDesbloqueio(); }, []);

  // Fonte dos eventos: modo `poll` (sem chave no front) OU Realtime (com Supabase/anon).
  useEffect(() => {
    const vistos = new Set<number>(); // dedupe por id
    const emitir = (v: VendaCelebracao) => {
      if (v == null || vistos.has(v.id)) return;
      vistos.add(v.id);
      fila.current.push(v);
      proxima();
    };

    // --- Modo POLL: pergunta a uma função (ex.: Edge Function). Nenhuma chave no navegador. ---
    if (poll) {
      let ativo = true;
      let lastSeen: number | null = null;
      const tick = async () => {
        try {
          const { latestId, novas } = await poll(lastSeen);
          if (!ativo) return;
          if (lastSeen === null) {
            lastSeen = latestId; // baseline: não celebra vendas que já existiam ao abrir
          } else {
            for (const v of novas) emitir(v);
            if (latestId > lastSeen) lastSeen = latestId;
          }
        } catch {
          /* silencioso: a celebração não é crítica */
        }
      };
      tick();
      const iv = setInterval(tick, intervaloMs);
      return () => { ativo = false; clearInterval(iv); };
    }

    // --- Modo Realtime (com Supabase/anon) ---
    let client: Pick<SupabaseClient<any, any, any>, "channel" | "removeChannel"> | null = supabase ?? null;
    if (!client && url && anonKey) {
      client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    if (!client) {
      console.warn("[CelebracaoVenda] passe `poll`, `supabase` ou `url` + `anonKey`.");
      return;
    }
    const canal = client
      .channel("vendas-celebracao-" + Math.random().toString(36).slice(2, 8))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "vendas_celebracao" }, (payload) => {
        emitir(payload.new as VendaCelebracao);
      })
      .subscribe();
    return () => { client!.removeChannel(canal); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, url, anonKey, poll, intervaloMs]);

  function proxima() {
    if (mostrando.current) return;
    const v = fila.current.shift();
    if (!v) return;
    mostrando.current = true;
    setVenda(v);
    if (!lerMudo() && reivindicarSom(v.id)) tocarSom(somUrl, volume, repeticoesSom);
    requestAnimationFrame(() => {
      if (canvasRef.current) pararConfete.current = soltarConfete(canvasRef.current, duracaoSegundos * 1000 - 1500);
    });
    timer.current = setTimeout(fechar, duracaoSegundos * 1000);
  }
  function fechar() {
    if (timer.current) clearTimeout(timer.current);
    pararConfete.current();
    setVenda(null);
    mostrando.current = false;
    setTimeout(proxima, 400);
  }
  function alternarMudo() { const v = !mudo; setMudo(v); gravarMudo(v); }

  if (!venda) return null;
  const valor = brl(venda.preco_lote);
  const quem = venda.venda_externa && venda.corretor_nome
    ? `${venda.corretor_nome}${venda.consultor_nome ? ` · via ${venda.consultor_nome}` : ""}`
    : venda.consultor_nome;

  return (
    <div style={S.overlay} role="status" aria-live="polite" onClick={fechar}>
      <canvas ref={canvasRef} style={S.canvas} />
      <style>{CSS}</style>
      <div style={S.card} className="cv-card" onClick={(e) => e.stopPropagation()}>
        <div style={S.emoji} className="cv-emoji">🎉</div>
        <div style={S.titulo}>VENDA REALIZADA!</div>
        <div style={S.emp}>
          {venda.empreendimento ?? "Empreendimento"}
          {venda.numero_lote ? <span style={S.lote}> · Lote {venda.numero_lote}</span> : null}
        </div>
        {valor ? <div style={S.valor}>{valor}</div> : null}
        {quem ? <div style={S.quem}>{quem}</div> : null}
        <div style={S.rodape}>
          <span>{sistema ? `Pingolead → ${sistema}` : "Pingolead"}</span>
          <button type="button" onClick={alternarMudo} style={S.btn} title={mudo ? "Ativar som" : "Silenciar neste navegador"}>
            {mudo ? "🔇" : "🔊"}
          </button>
          <button type="button" onClick={fechar} style={S.btn} title="Fechar">✕</button>
        </div>
      </div>
    </div>
  );
}

const CSS = `
@keyframes cvPop{0%{transform:translateY(40px) scale(.8);opacity:0}60%{transform:translateY(-6px) scale(1.04);opacity:1}100%{transform:translateY(0) scale(1);opacity:1}}
@keyframes cvBounce{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-10px) rotate(8deg)}}
@keyframes cvGlow{0%,100%{box-shadow:0 20px 60px rgba(0,0,0,.45),0 0 0 0 rgba(245,158,11,.6)}50%{box-shadow:0 20px 60px rgba(0,0,0,.45),0 0 0 14px rgba(245,158,11,0)}}
.cv-card{animation:cvPop .55s cubic-bezier(.2,.9,.3,1.2) both, cvGlow 1.6s ease-in-out .5s infinite}
.cv-emoji{animation:cvBounce 1.1s ease-in-out infinite}
`;

const S: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,.35)", backdropFilter: "blur(2px)", cursor: "pointer" },
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" },
  card: { position: "relative", minWidth: 320, maxWidth: "min(92vw, 520px)", padding: "28px 32px 18px", borderRadius: 20, textAlign: "center",
    color: "#fff", cursor: "default", background: "linear-gradient(160deg,#0f172a 0%,#1e293b 60%,#0f172a 100%)", border: "1px solid rgba(255,255,255,.12)",
    fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif" },
  emoji: { fontSize: 56, lineHeight: 1, marginBottom: 6 },
  titulo: { fontSize: 13, letterSpacing: 4, fontWeight: 800, color: "#fbbf24", marginBottom: 10 },
  emp: { fontSize: 26, fontWeight: 800, lineHeight: 1.15 },
  lote: { fontWeight: 600, color: "#cbd5e1" },
  valor: { fontSize: 34, fontWeight: 900, marginTop: 8, color: "#34d399", letterSpacing: -1 },
  quem: { marginTop: 10, fontSize: 16, color: "#e2e8f0" },
  rodape: { marginTop: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 11, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase" },
  btn: { background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", color: "#e2e8f0", borderRadius: 8, padding: "3px 8px", cursor: "pointer", fontSize: 13, lineHeight: 1.2 },
};
