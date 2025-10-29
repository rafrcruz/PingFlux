# PingFlux

Monitor de conectividade local que coleta ping, DNS e HTTP para ajudar a entender estabilidade de rede sem depender de serviços externos.

## Como rodar em 60s

1. Clone o repositório: `git clone https://github.com/sua-org/pingflux.git && cd pingflux`
2. Instale dependências: `npm install`
3. Copie o template de configuração: `cp .env.example .env`
4. Ajuste alvos, se necessário, e inicie: `npm start`

## Interpretação rápida dos KPIs

- **p95 de latência**: mostra a cauda lenta; acompanhe aumentos sustentados para identificar saturação.
- **Média de latência**: indica tendência geral; útil para comparar janelas ou locais diferentes.
- **Perda (%)**: percentual de pacotes sem resposta; acima de 1% afeta voz/vídeo.
- **Disponibilidade (%)**: porcentagem de janelas sem falha em nenhum coletor; quedas sinalizam interrupções totais.
- **DNS lookup (ms)**: tempo para resolver hostnames; altos valores geram páginas carregando indefinidamente.
- **TTFB (ms)**: atraso até o primeiro byte HTTP; detecta gargalos de servidor, CDN ou TLS.

Para descrições aprofundadas consulte [`docs/INTERPRETACAO.md`](docs/INTERPRETACAO.md).

## Estados de saúde

Os componentes calculam janelas agregadas de 1 minuto. A UI apresenta o pior estado observado na janela selecionada:

- **OK**: métricas abaixo dos valores `THRESH_*_WARN_*`.
- **ATENÇÃO**: métricas entre o limiar de WARN e o crítico (`THRESH_*_CRIT_*`). Use para acompanhar.
- **CRÍTICO**: métricas acima do limiar crítico ou ausência de dados recentes. Requer ação imediata.

Ajuste os thresholds no `.env` para representar seu baseline real.

## Troubleshooting rápido

- **Diagnóstico do ambiente**: `npm run diag`
- **Saúde do banco**: `npm run db:health`
- **Rotina de retenção**: `npm run maintenance:run`
- **Agregação manual**: `npm run ping:aggregate -- --since <epochMs>`

## Health & Diagnóstico

- **Endpoint `/health`**: retorna JSON com `status`, `uptime_s`, `components` (db, ping, dns, http, live),
  `targets_active` e `timestamp`. O status é `ok` apenas quando todos os componentes respondem com `ok`.
- **Smoke test rápido**: `npm run smoke` valida o banco, verifica `/health` e garante eventos SSE em
  `/v1/live/metrics` em menos de 10 segundos.
- **Diagnóstico completo**: combine `npm run diag` com o endpoint `/health` para isolar falhas de coleta ou web.

## FAQ / Erros comuns

- **Porta 3030 já em uso**: altere `PORT` no `.env` ou finalize o processo que mantém a porta ocupada.
- **Banco corrompido ou bloqueado**: pare o processo (`Ctrl+C`), apague o arquivo em `./data/netmon.sqlite` (ou rode `npm run db:reset`) e reinicie.
- **Ping bloqueado no Windows**: use `PING_METHOD_PREFERENCE=tcp` ou execute como administrador para liberar ICMP.
- **Shutdown lento**: o processo aguarda encerrar coletores ativos; espere alguns segundos ou finalize com `Ctrl+C` duas vezes.
- **Sem dados novos**: confirme se os alvos respondem (`npm run ping:once -- <host>`) e revise `ENABLE_*` no `.env`.

## Comandos úteis

- `npm run config:print` — exibe a configuração efetiva carregada.
- `npm run db:init` — cria ou atualiza o esquema SQLite local.
- `npm run db:health` — valida conexão com o banco.
- `npm run ping:aggregate` — consolida amostras de ping em janelas de 1 minuto.
- `npm run maintenance:run` — executa retenção de dados conforme limites configurados.
- `npm run start` — inicia runtime unificado (web + coletores).
- `npm run diag` — gera relatório rápido do ambiente e das tabelas.

## Manutenção e limpeza

- **Retenção periódica**: `npm run maintenance:run` mantém o banco enxuto conforme configuração.
- **Reset controlado**: `npm run db:reset` remove dados coletados preservando o esquema para uma nova coleta limpa.
- **Agregações manuais**: `npm run ping:aggregate -- --since <epochMs>` recompõe janelas históricas após interrupções.
- **Arquivos temporários**: diretórios `data/`, `coverage/` e arquivos `*.log` ficam fora do versionamento (`.gitignore`).

## Padrões de código (ESLint/Prettier)

- **Lint**: `npm run lint` aplica ESLint (ES2022, Node) em todo o projeto.
- **Formatação**: `npm run format` usa Prettier para alinhar código, scripts e docs padrão.
- **Logger**: use `src/utils/logger.js` (`info`, `warn`, `error`) para manter logs no formato `[NÍVEL][COMPONENTE] mensagem`.

## Privacidade

Tudo roda localmente em `127.0.0.1`. O PingFlux não envia medições para servidores externos; o banco fica no diretório `./data` do seu computador.
