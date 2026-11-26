# Fontes, custos e limites (verificado em 25/11/2026)

| Dado | Fonte | Acesso testado | Custo | Frequência no sistema | Observações |
|---|---|---|---|---|---|
| PTAX (USD, EUR, GBP e outras 7) | Banco Central – Olinda OData | Sim, funcionando | Gratuito, sem chave | 30 min (boletins) + carga diária | Referência oficial. **CNY e ARS não têm PTAX.** Boletins saem ~10h–13h; fechamento = valor do dia. Feriados não são tratados. |
| Cotação de mercado (comercial) e turismo | AwesomeAPI (`economia.awesomeapi.com.br`) | Sim, sem chave | Gratuito; limites e eventual chave não verificados | 5 min | Agregador **não oficial**, sem SLA. Não é tempo real garantido. Usar `AWESOMEAPI_KEY` não foi testado. |
| Notícias oficiais | RSS/Atom: BCB, Receita Federal, Agência Câmara, Agência Senado | Sim | Gratuito | 20 min | Sem feed: Planalto, Diário Oficial da União, Ministério da Fazenda (não integrados). |
| Notícias gerais | Agência Brasil, InfoMoney, BBC Brasil (RSS) | Sim | Gratuito | 20 min | Uso conforme termos de cada veículo; guardamos título, resumo curto e link. |
| Notícias do exterior / temas | Google Notícias (RSS de busca) | Sim | Gratuito | 20 min | Agregador; o link redireciona à publicação original. Sem garantia de disponibilidade. |
| Tramitação legislativa | API de Dados Abertos da Câmara | Sim | Gratuito, sem chave | 60 min | Oficial. Dá situação e histórico; **não informa regulamentação nem vigência**. Matérias só no Senado podem ter detalhe incompleto. |
| E-mail | SMTP do seu provedor | **Não testado** (sem credenciais) | Conforme provedor | fila a cada 1 min | Código implementado com nodemailer. |
| Telegram | Bot API | **Não testado** (sem token) | Gratuito | fila a cada 1 min | Código implementado. |

Não foi usada IA: resumos e classificação são regras determinísticas (`src/analysis`).
