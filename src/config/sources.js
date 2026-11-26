// Fontes de notícias. `official: true` marca órgão público (prioridade na relevância).
// `needTopic`: só guarda itens que casem com algum tema econômico/tributário (feeds gerais).
// Os feeds do Google News são AGREGADOR: o link abre a publicação original após redirecionamento do Google.
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

export const FEEDS = [
  { id: 'bcb', name: 'Banco Central do Brasil', url: 'https://www.bcb.gov.br/api/feed/sitebcb/sitefeeds/noticias', official: true, region: 'BR', needTopic: true },
  { id: 'receita', name: 'Receita Federal', url: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/RSS', official: true, region: 'BR', needTopic: false, forceTopic: 'tributario' },
  { id: 'camara', name: 'Agência Câmara', url: 'https://www.camara.leg.br/noticias/rss/ultimas-noticias', official: true, region: 'BR', needTopic: true },
  { id: 'senado', name: 'Agência Senado', url: 'https://www12.senado.leg.br/noticias/rss', official: true, region: 'BR', needTopic: true },
  { id: 'agbrasil', name: 'Agência Brasil', url: 'https://agenciabrasil.ebc.com.br/rss/economia/feed.xml', official: false, region: 'BR', needTopic: true },
  { id: 'infomoney', name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', official: false, region: 'BR', needTopic: true },
  { id: 'bbc', name: 'BBC News Brasil', url: 'https://feeds.bbci.co.uk/portuguese/rss.xml', official: false, region: 'EXT', needTopic: true },
  // Agregador: cobre acontecimentos no exterior e temas específicos
  { id: 'gn-fed', name: 'Google Notícias', url: gnews('Federal Reserve juros dólar'), aggregator: true, region: 'EXT', needTopic: true },
  { id: 'gn-oil', name: 'Google Notícias', url: gnews('petróleo Brent preço mercado'), aggregator: true, region: 'EXT', needTopic: true },
  { id: 'gn-trade', name: 'Google Notícias', url: gnews('tarifas comércio EUA China Brasil exportações'), aggregator: true, region: 'EXT', needTopic: true },
  { id: 'gn-china', name: 'Google Notícias', url: gnews('economia China yuan PIB'), aggregator: true, region: 'EXT', needTopic: true },
  { id: 'gn-argentina', name: 'Google Notícias', url: gnews('Argentina peso economia Milei'), aggregator: true, region: 'EXT', needTopic: true },
  { id: 'gn-copom', name: 'Google Notícias', url: gnews('Copom Selic IPCA dólar real'), aggregator: true, region: 'BR', needTopic: true },
  { id: 'gn-fiscal', name: 'Google Notícias', url: gnews('arcabouço fiscal déficit dívida pública governo'), aggregator: true, region: 'BR', needTopic: true },
  { id: 'gn-reforma', name: 'Google Notícias', url: gnews('reforma tributária IBS CBS regulamentação'), aggregator: true, region: 'BR', needTopic: true },
];
