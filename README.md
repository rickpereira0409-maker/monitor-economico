# Monitor Econômico e Tributário

Painel em português para empresas brasileiras: câmbio (PTAX, comercial, turismo), notícias que podem influenciar o dólar, reforma tributária e legislação, agenda de prazos e central de alertas (painel, e-mail e Telegram).

## Versão gratuita no GitHub (app no celular + alertas ntfy)
Sem servidor e sem custo. O workflow `.github/workflows/coletar.yml` roda a cada ~15 min (o GitHub pode atrasar), executa `scripts/collect.js` (coleta, avalia alertas, envia notificação para o **ntfy**) e publica o app no **GitHub Pages**.
- **Estado:** o banco SQLite fica na branch `data` (substituída a cada execução, sem acumular histórico no Git).
- **App:** PWA instalável (`public/`). Mercado (dólar etc.) é consultado ao vivo pelo próprio celular a cada 15 s enquanto o app está aberto; PTAX, notícias, legislação e histórico vêm da última coleta.
- **Configuração:** `config/settings.json` (moedas, regras de alerta, horários, prazos). Edite no GitHub e salve; vale na próxima coleta. Nesta versão o painel é somente leitura (favoritos e "lidos" ficam no aparelho).
- **Segredo:** `NTFY_TOPIC` (nome secreto do tópico) em Settings > Secrets and variables > Actions. Quem souber o tópico lê os alertas: use um nome longo e aleatório.
- **Celular:** instale o app ntfy, assine o tópico, abra o link do Pages e use "Adicionar à tela inicial".
- **Pausa por inatividade:** o GitHub pausa agendamentos de repositórios sem atividade por 60 dias; cada execução faz um push na branch `data`, o que mantém o repositório ativo. Se mesmo assim pausar, o app exibe "Dados desatualizados"; reative em Actions > Coletar e publicar > Enable workflow.

## Arquitetura (versão com servidor próprio)
Um único processo Node 24 (sem build, SQLite embutido, só `nodemailer` como dependência):
- **Coleta agendada no servidor** (`src/jobs.js`, `src/scheduler.js`): roda mesmo com o painel fechado, com tentativas, espera crescente e estado por tarefa (visível em Configurações).
- **Alertas** (`src/alerts`): gatilhos, deduplicação por chave, fila de envio com retentativas.
- **Painel** (`public/`): JS puro, responsivo, modo claro/escuro. Todo texto externo entra via `textContent`; CSP restritivo.
- **Dados** em `DB_PATH` (SQLite). Fuso: America/Sao_Paulo.

## Instalação local
```bash
npm install
npm test                 # 40 testes
npm run check:sources    # testa de verdade cada fonte externa
npm start                # http://localhost:3000 (sem senha em desenvolvimento)
npm run seed:demo        # opcional: itens etiquetados "DEMONSTRAÇÃO" (--remove apaga)
```
As primeiras coletas ocorrem nos primeiros ~40 s.

## Variáveis de ambiente
Veja `.env.example`. Em produção `ACCESS_PASSWORD` (≥8) e `SESSION_SECRET` (≥32) são obrigatórias; o servidor não inicia sem elas.

## Agendamentos (padrão)
| Tarefa | Intervalo | Variável |
|---|---|---|
| Cotações de mercado | 5 min | `FX_MARKET_INTERVAL_MIN` |
| PTAX | 30 min | `FX_PTAX_INTERVAL_MIN` |
| Notícias | 20 min | `NEWS_INTERVAL_MIN` |
| Legislação | 60 min | `LEGISLATION_INTERVAL_MIN` |
| Alertas, prazos, resumos, envios | 1 min | `ALERTS_INTERVAL_MIN` |
| Histórico de câmbio / limpeza | 24 h | fixo |

## Publicação
Precisa de processo **sempre ligado** e **disco persistente** (não serve para funções serverless, como a Vercel, porque o agendador e o SQLite exigem estado). Opções de baixo custo: VPS pequena, Fly.io, Railway ou Render (serviço com disco).
```bash
docker build -t monitor .
docker run -d --restart=always -p 3000:3000 -v monitor-data:/data --env-file .env monitor
```
Coloque atrás de HTTPS (Caddy/Nginx/provedor) e defina `TRUST_PROXY=true`. Faça backup periódico de `/data/monitor.db`.

## Configurar e-mail e Telegram
- **E-mail**: preencha `SMTP_*` no servidor; em Configurações > Entrega informe o destinatário, ative e use "Enviar teste".
- **Telegram**: crie um bot no @BotFather, coloque o token em `TELEGRAM_BOT_TOKEN`, envie uma mensagem ao bot e use "Descobrir meu Chat ID".
Sem credenciais, o resto funciona e o painel mostra o canal como "não configurado".

## Como os alertas evitam repetição
- Preço: dispara ao cruzar o limite e só rearma depois de voltar ao outro lado; mais intervalo mínimo por regra.
- Notícia: uma por versão. Republicação (mesmo conteúdo) e ajuste mínimo não alertam; mudança relevante de título/resumo gera "Atualização". A mesma matéria em outra fonte é marcada como duplicada.
- Legislação: alerta por mudança de etapa/situação (ou toda movimentação, se escolhido); a primeira leitura é só linha de base.
- Envio externo: respeita janela de horário e intervalo mínimo; alertas acumulados saem numa mensagem.

## Agenda e prazos
O sistema **não traz calendário oficial embutido**: para não publicar data de memória, prazos e marcos legais entram quando você os cadastra (com link oficial). Eles geram lembretes (7, 3, 1 dia e no dia, configurável).

## Limitações
Ver o resumo no final da entrega e `docs/FONTES.md`. Acesso por senha única (sem multiusuário na v1).
