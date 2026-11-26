import { CATALOG } from '../config/currencies.js';
import { GLOSSARY } from '../config/glossary.js';
import { TOPIC_LIST } from '../analysis/news.js';
import { STAGES } from '../analysis/legislation.js';
import { RULE_TYPES } from '../alerts/engine.js';

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

/** Dados estáticos usados pelo painel (listas, glossário, etapas). */
export function buildMeta() {
  return {
    topics: TOPIC_LIST, stages: STAGES, glossary: GLOSSARY, ruleTypes: RULE_TYPES,
    currencies: CATALOG.map(({ code, name, pair, ptax, tourism, decimals }) => ({ code, name, pair, ptax, tourism: !!tourism, decimals })),
    regimes: ['MEI', 'Simples Nacional', 'Lucro Presumido', 'Lucro Real'],
    ufs: UFS,
  };
}
