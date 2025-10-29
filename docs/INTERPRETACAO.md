# Interpretação dos principais indicadores

Este guia complementa o resumo do README com detalhes adicionais para ajudar nas investigações de rede.

## Latência p95
- **O que é**: o percentil 95 da latência (RTT ou TTFB) observada na janela. 95% das medições ficam abaixo deste valor.
- **Por que importa**: identifica caudas lentas que afetam usuários reais mesmo quando a média está aceitável. Um aumento persistente costuma indicar congestionamento, filas em roteadores ou saturação do provedor.
- **Boas práticas**: acompanhe p95 em janelas de 1 minuto para incidentes agudos, 5 minutos para validar correções e 1 hora para detectar padrões de horário. Considere WARN quando ultrapassar `THRESH_P95_WARN_MS` e CRIT quando cruzar `THRESH_P95_CRIT_MS`.

## Perda de pacotes
- **O que é**: porcentagem de pings sem resposta dentro do timeout.
- **Impacto**: perdas acima de 1% já podem degradar chamadas de voz ou vídeo (voz robotizada, quadros congelados) e derrubar conexões TCP. Identificar se a perda é pontual ou contínua ajuda a priorizar ações.
- **Dicas**: monitore alvos dentro e fora da rede para diferenciar problemas internos x externos. Use janelas de 5 minutos para filtrar spikes curtos e 1 hora para observar estabilidade. Alerte em WARN a partir de `THRESH_LOSS_WARN_PCT` e trate como CRIT acima de `THRESH_LOSS_CRIT_PCT`.

## Disponibilidade
- **O que é**: proporção de janelas em que todos os checadores reportaram sucesso.
- **Sinais de problema**: quedas de disponibilidade acompanhadas de perda alta indicam interrupções totais. Combine com logs da aplicação alvo para entender o impacto no usuário.
- **Dicas**: mantenha pelo menos um alvo interno e outro público para separar falhas locais de rotas externas. Valores abaixo de 99% em 1 hora merecem investigação.

## DNS Lookup
- **O que é**: tempo para resolver um hostname (consulta + resposta).
- **Sintomas**: demoras no DNS resultam em páginas "Carregando" prolongadas, timeouts em chamadas API e erros intermitentes em login. Se a latência DNS sobe junto com TTFB, há chance de problema de rede geral; se só o DNS sobe, revise servidores resolvers.
- **Dicas**: defina hostnames críticos (APIs, autenticação). Use WARN acima de `THRESH_DNS_WARN_MS` e CRIT acima de `THRESH_DNS_CRIT_MS`. Em ambientes corporativos, avaliar janelas de 5 minutos expõe picos decorrentes de limitação ou quedas de caches.

## Time To First Byte (TTFB)
- **O que é**: tempo entre a requisição HTTP e o primeiro byte de resposta.
- **Gargalos comuns**: lentidão no servidor web, filas em CDN, problemas TLS ou saturação de upstream. Se p95 de TTFB sobe sem mudança em DNS ou perda, o gargalo está após a resolução.
- **Dicas**: acompanhe TTFB para endpoints críticos (status API, CDN de arquivos). Alvos com TTFB acima de `THRESH_TTFB_WARN_MS` afetam experiência percebida; acima de `THRESH_TTFB_CRIT_MS` indicam incidentes.

## Escolha de targets
- Combine IPs públicos (8.8.8.8), privados (gateway, firewall) e nomes de hosts críticos para cobrir toda a jornada.
- Separe grupos por função: `PING_TARGETS` para reachability, `DNS_HOSTNAMES` para resolução e `HTTP_URLS` para experiência completa.

## Ranges de análise sugeridos
- **1 minuto**: detectar quedas bruscas ou instabilidades recentes.
- **5 minutos**: validar mitigação e filtrar falsos positivos.
- **1 hora**: observar tendências, janelas com perda recorrente ou latência acima de baseline.

## Quando escalar (WARN vs CRIT)
- **WARN**: mantenha acompanhamento próximo, abra ticket de monitoramento e valide se há manutenção ou mudança recente.
- **CRIT**: acione equipes responsáveis, pois o impacto já deve ser perceptível. Combine com `npm run maintenance:run` para garantir retenção e com `npm run diag` para confirmar ambiente.
