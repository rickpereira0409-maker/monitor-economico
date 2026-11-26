import { byCode, RATE_TYPES } from '../config/currencies.js';

export const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtBRL = (v, code) => `R$ ${fmtNum(v, byCode[code]?.decimals ?? 4)}`;
export const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, 2)}%`);
export const typeLabel = (t) => RATE_TYPES[t]?.label || t;
