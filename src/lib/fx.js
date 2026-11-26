import { spParts, spDate, lastWeekday, addDays } from './time.js';

/** Variação percentual de `current` sobre `previous`. Retorna null se não for calculável. */
export function pctChange(current, previous) {
  if (current == null || previous == null || current === '' || previous === '') return null; // Number(null) seria 0 e geraria -100%
  const c = Number(current), p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

export const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/**
 * Variação dentro de uma janela de tempo.
 * series: [{t: ms, v: número}] em qualquer ordem. Usa o ponto mais antigo dentro da janela como base.
 * Exige ao menos 2 pontos e que a base esteja a pelo menos 50% da janela de distância
 * (evita chamar de "variação em 1 h" a diferença entre dois pontos de 2 minutos).
 */
export function windowChange(series, windowMs, nowMs) {
  const pts = series.filter((s) => Number.isFinite(s.v) && s.t <= nowMs && s.t >= nowMs - windowMs).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  if (last.t - first.t < windowMs * 0.5) return null;
  return { from: first, to: last, pct: pctChange(last.v, first.v) };
}

/** Situação do mercado cambial interbancário brasileiro (9h–17h, dias úteis; feriados não considerados). */
export function marketStatus(now) {
  const p = spParts(now);
  const mins = p.hour * 60 + p.minute;
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const open = weekday && mins >= 9 * 60 && mins < 17 * 60;
  let reason = 'Mercado interbancário brasileiro aberto (9h às 17h, dias úteis).';
  if (!open) reason = weekday ? 'Fora do horário do mercado interbancário (9h às 17h).' : 'Fim de semana: mercado interbancário fechado.';
  return { open, label: open ? 'Mercado aberto' : 'Mercado fechado', reason };
}

/**
 * Atualidade de uma cotação.
 *  - ptax: atual se for do último dia útil (ou posterior).
 *  - demais: com mercado aberto, atrasada se tiver mais de 20 min; fechado, atrasada se tiver mais de 72 h.
 * Retorna { stale, ageMin, note }.
 */
export function freshness(quoteTs, rateType, now) {
  const age = (now.getTime() - new Date(quoteTs).getTime()) / 60000;
  if (rateType === 'ptax') {
    // O primeiro boletim do dia sai ~10h; antes das 10h30 o esperado é a PTAX do dia útil anterior.
    const p = spParts(now);
    const todayExpected = p.weekday >= 1 && p.weekday <= 5 && p.hour * 60 + p.minute >= 10 * 60 + 30;
    const expected = todayExpected ? p.date : lastWeekday(addDays(p.date, -1));
    const stale = spDate(new Date(quoteTs)) < expected;
    return { stale, ageMin: Math.round(age), note: stale ? 'A PTAX mais recente é anterior à esperada para hoje (feriados nacionais não são considerados).' : null };
  }
  const m = marketStatus(now);
  if (m.open) {
    const stale = age > 20;
    return { stale, ageMin: Math.round(age), note: stale ? `Dados atrasados: última cotação há ${Math.round(age)} min com o mercado aberto.` : null };
  }
  const stale = age > 72 * 60;
  return { stale, ageMin: Math.round(age), note: stale ? 'Dados desatualizados: sem cotação nova há mais de 72 h.' : null };
}
