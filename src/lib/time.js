// Utilitários de data/hora. Tudo é armazenado em UTC (ISO 8601) e exibido em America/Sao_Paulo.
export const TZ = 'America/Sao_Paulo';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Partes da data no fuso de São Paulo. weekday: 0=domingo ... 6=sábado. */
export function spParts(d) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS.indexOf(p.weekday),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** 'YYYY-MM-DD' no fuso de São Paulo. */
export const spDate = (d) => spParts(d).date;

/**
 * Converte "YYYY-MM-DD HH:MM:SS(.ffffff)" em horário de Brasília (como o BCB publica) para Date.
 * O Brasil não adota horário de verão desde 2019, então o deslocamento é fixo em -03:00.
 */
export function spLocalToDate(str) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str || '');
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtSP(d, { seconds = false } = {}) {
  if (!d) return '—';
  const p = spParts(new Date(d));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}${seconds ? ':' + pad(p.second) : ''}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dias corridos de a até b (datas 'YYYY-MM-DD'). Positivo se b é depois de a. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/** Último dia útil (seg–sex) em ou antes de dateStr. Feriados nacionais NÃO são considerados. */
export function lastWeekday(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 7; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) return d;
    d = addDays(d, -1);
  }
  return d;
}

/** 'YYYY-MM-DD' -> 'MM-DD-YYYY', formato exigido pelos parâmetros de data da API do BCB. */
export const bcbDate = (dateStr) => `${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)}-${dateStr.slice(0, 4)}`;
