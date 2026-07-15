# Segurança — Simulador de Vendas

Regras inegociáveis deste sistema. Toda mudança deve respeitá-las.

1. **Login obrigatório.** Nada é acessível sem autenticação (Supabase Auth, Google `@youngempreendimentos.com.br`) e sem estar na allowlist (`simulador_usuarios`).
2. **RLS "negar por padrão".** Toda tabela `simulador_` tem RLS ligado e **nega a role `anon`**. A chave publishable do front não lê nem escreve nada sensível. Cada usuário autenticado só enxerga o que seu papel permite.
3. **Segredos só no servidor.** Taxa de juros, `service_role`, chaves de Resend e Google ficam em **Edge Functions** (variáveis de ambiente do Supabase). Nunca no código do navegador, nunca no Git.
4. **Permissões validadas no servidor.** Autonomia comercial e bonificação são checadas pelo **usuário logado** (`auth.uid()` / e-mail), não por um nome digitado. O front só sugere a UI; a decisão é do servidor.
5. **Cálculos determinísticos.** Parcela, comissão, bonificação, autonomia e contrato saem de regras fixas + dados do banco. **Sem IA nos números ou no contrato.**
6. **Auditoria.** Toda ação sensível (autonomia, bônus, override de disponibilidade, emissão de contrato) é registrada.
7. **Nada de segredo no Git.** `.env` é ignorado; o front recebe apenas a chave publishable (que, por RLS, não alcança dado sensível). Histórico limpo.

## Estado da chave publishable
O front usa a chave publishable do `young-workspace`. Ela é pública por design; a proteção vem do RLS. A Young vai **rotacionar** a chave exposta e limpar o RLS dos outros sistemas — ao rotacionar, basta atualizar `VITE_SUPABASE_ANON_KEY` no `.env`/deploy.
