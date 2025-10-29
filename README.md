# PingFlux

Monitoramento leve de rede com coletores de ping, DNS e HTTP utilizando SQLite.

## Como rodar em 60s

1. Clone este repositório e entre na pasta `PingFlux`.
2. Instale dependências: `npm install`.
3. Copie `.env.example` para `.env` e ajuste se necessário.
4. Inicie tudo com `npm start` (coletores + servidor web em `127.0.0.1:3030`).
5. Pressione `Ctrl+C` para encerrar – o shutdown respeita um período de até 5s.

## KPIs em 1 minuto

- **Ping**: janelas de 1, 5 e 60 minutos com média, p95 e perda (`/v1/live/metrics`).
- **DNS lookup**: médias em 1, 5 e 60 minutos, útil para detectar lentidões de resolução.
- **HTTP**: TTFB e tempo total médios, consolidados por janela.
- O payload live inclui `schema`, `units`, `heartbeat` e pode ser consumido por múltiplos clientes.

## Saúde e Prontidão

- `GET /health` retorna:
  ```json
  {
    "db": { "ok": true, "size_mb": 1.23, "last_vacuum_at": null },
    "collectors": { "ping": "up", "dns": "up", "http": "up" },
    "live": { "interval_ms": 2000, "subscribers": 1, "last_dispatch_ts": 1700000000000 }
  }
  ```
- `GET /ready` valida abertura do banco e migrations.
- Dados históricos e leitura agregada disponíveis em `/v1/api/*` (ping/dns/http, parâmetros validados).

## Scripts úteis

- `npm run db:migrate` — aplica migrations pendentes no SQLite.
- `npm run diag` — imprime versão do Node, caminho do banco e contagem de amostras.
- `npm run parse:test` — valida parsing de `ping`/`traceroute` usando fixtures reais.
- `npm run lint` / `npm run format` — verificam ou aplicam Prettier.

## Troubleshooting rápido

- Porta ocupada? Ajuste `PORT` no `.env` (servidor sempre faz bind em `127.0.0.1`).
- Ping bloqueado no sistema? Configure `PING_METHOD`/`PING_TARGETS` ou desative via feature flag.
- Banco corrompido? Pare o serviço, remova `./data/netmon.sqlite` e execute `npm run db:migrate`.
