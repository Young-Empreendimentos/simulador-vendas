# Simulador de Vendas — Young

Sistema interno de **simulação de financiamento → emissão de contrato**, com login e permissões por usuário. Ligado ao Lotfinder (o mapa de lotes): de lá, um botão abre este sistema já com empreendimento e lote pré-selecionados.

Substitui o bot n8n/IA por uma **UI + backend determinístico e seguro** (ver [`SECURITY.md`](./SECURITY.md)).

## Stack
- React + Vite + TypeScript + Tailwind
- Supabase (Auth Google `@young`, Postgres com RLS, Edge Functions para toda lógica sensível)

## Rodar local
```bash
cp .env.example .env   # preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## Acesso
Login com Google `@youngempreendimentos.com.br`. Quem não estiver na allowlist (`simulador_usuarios`) vê "acesso pendente". Papéis: `admin`, `coordenador`, `consultor`, com flags `pode_autonomia` e `pode_bonificar`.

## Status
Fase 0 (fundação) — login + controle de acesso. Próximo: simulador, comissão/autonomia/bônus, contrato, e-mails.
