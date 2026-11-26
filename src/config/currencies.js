// Catálogo de moedas. `aw` é o par na AwesomeAPI; `ptax` indica se o BCB publica PTAX para a moeda
// (verificado em 25/11/2026 em olinda.bcb.gov.br/.../PTAX/versao/v1/odata/Moedas: AUD CAD CHF DKK EUR GBP JPY NOK SEK USD).
// CNY e ARS NÃO têm PTAX: para elas só existe cotação de mercado (comercial).
export const CATALOG = [
  { code: 'USD', name: 'Dólar americano', pair: 'USD/BRL', core: true, ptax: true, tourism: true, decimals: 4 },
  { code: 'EUR', name: 'Euro', pair: 'EUR/BRL', core: true, ptax: true, tourism: true, decimals: 4 },
  { code: 'CNY', name: 'Yuan chinês', pair: 'CNY/BRL', core: true, ptax: false, decimals: 4 },
  { code: 'GBP', name: 'Libra esterlina', pair: 'GBP/BRL', core: true, ptax: true, decimals: 4 },
  { code: 'ARS', name: 'Peso argentino', pair: 'ARS/BRL', core: true, ptax: false, decimals: 5 },
  // Opcionais (ativáveis em Configurações)
  { code: 'JPY', name: 'Iene japonês', pair: 'JPY/BRL', ptax: true, decimals: 5 },
  { code: 'CAD', name: 'Dólar canadense', pair: 'CAD/BRL', ptax: true, decimals: 4 },
  { code: 'CHF', name: 'Franco suíço', pair: 'CHF/BRL', ptax: true, decimals: 4 },
  { code: 'AUD', name: 'Dólar australiano', pair: 'AUD/BRL', ptax: true, decimals: 4 },
  { code: 'MXN', name: 'Peso mexicano', pair: 'MXN/BRL', ptax: false, decimals: 4 },
  { code: 'CLP', name: 'Peso chileno', pair: 'CLP/BRL', ptax: false, decimals: 5 },
  { code: 'COP', name: 'Peso colombiano', pair: 'COP/BRL', ptax: false, decimals: 6 },
  { code: 'UYU', name: 'Peso uruguaio', pair: 'UYU/BRL', ptax: false, decimals: 4 },
  { code: 'PYG', name: 'Guarani paraguaio', pair: 'PYG/BRL', ptax: false, decimals: 6 },
];

export const byCode = Object.fromEntries(CATALOG.map((c) => [c.code, c]));

export const RATE_TYPES = {
  ptax: {
    label: 'PTAX (referência do Banco Central)',
    short: 'PTAX',
    desc: 'Taxa de referência calculada pelo Banco Central a partir de quatro consultas a bancos ao longo do dia. Usada em contratos e na apuração de tributos. Aqui: valor de venda do boletim mais recente; o fechamento do dia é o valor oficial.',
  },
  comercial: {
    label: 'Dólar comercial (mercado)',
    short: 'Comercial',
    desc: 'Cotação de mercado usada em operações entre empresas e bancos (importação, exportação, câmbio comercial). Agregada pela AwesomeAPI a partir de fontes de mercado; valor de compra (bid).',
  },
  turismo: {
    label: 'Turismo (venda ao viajante)',
    short: 'Turismo',
    desc: 'Preço cobrado de pessoas físicas em casas de câmbio, com spread. NÃO serve de referência para operações empresariais. Aqui: preço de venda (ask), sem IOF.',
  },
};
