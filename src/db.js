import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATALOG } from './config/currencies.js';

export const DEFAULT_PREFS = {
  delivery: { startHour: 8, endHour: 20, weekdaysOnly: false, minIntervalMin: 30 },
  channels: { email: { enabled: false, to: '' }, telegram: { enabled: false, chatId: '' }, ntfy: { enabled: false } },
  digest: {
    daily: { enabled: true, hour: 8, channels: ['inapp'] },
    weekly: { enabled: true, weekday: 1, hour: 8, channels: ['inapp'] },
  },
  profile: { regime: '', setor: '', uf: '' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, pair TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, core INTEGER NOT NULL DEFAULT 0
);

-- Instantâneos de cotação (retidos por ~90 dias). rate_type: ptax | comercial | turismo
CREATE TABLE IF NOT EXISTS fx_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL, rate_type TEXT NOT NULL, source TEXT NOT NULL,
  value REAL NOT NULL, ask REAL, label TEXT,
  quote_ts TEXT NOT NULL, fetched_at TEXT NOT NULL,
  UNIQUE (code, rate_type, quote_ts)
);
CREATE INDEX IF NOT EXISTS idx_fxq ON fx_quotes (code, rate_type, quote_ts);

-- Fechamentos diários (histórico permanente). Para o dia corrente guarda a última cotação vista.
CREATE TABLE IF NOT EXISTS fx_daily (
  code TEXT NOT NULL, rate_type TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, source TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (code, rate_type, date)
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE, norm_title TEXT NOT NULL,
  url TEXT NOT NULL, source TEXT NOT NULL, feed TEXT, official INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, summary TEXT, published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  content_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_change TEXT,
  duplicate_of INTEGER, relevance INTEGER NOT NULL DEFAULT 0, level TEXT, direction TEXT, topics TEXT, analysis TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_news_pub ON news (published_at);
CREATE INDEX IF NOT EXISTS idx_news_norm ON news (norm_title);

CREATE TABLE IF NOT EXISTS legis_items (
  id TEXT PRIMARY KEY, camara_id INTEGER, sigla TEXT, numero INTEGER, ano INTEGER, title TEXT, ementa TEXT,
  source_url TEXT, official_url TEXT, situacao TEXT, cod_situacao INTEGER, stage TEXT, special TEXT,
  last_move_at TEXT, last_move_text TEXT, orgao TEXT, last_seq INTEGER,
  norma TEXT, curated INTEGER NOT NULL DEFAULT 0,
  regimes TEXT, setores TEXT, ufs TEXT, tributos TEXT, notes TEXT, watch TEXT,
  fetched_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legis_events (
  item_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT, orgao TEXT, descricao TEXT, situacao TEXT, stage TEXT,
  PRIMARY KEY (item_id, seq)
);

CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'prazo',
  description TEXT, source_url TEXT, origin TEXT NOT NULL DEFAULT 'usuario', ref TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (origin, ref)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, params TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '["inapp"]', cooldown_min INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_state (rule_id INTEGER PRIMARY KEY, armed INTEGER NOT NULL DEFAULT 1, last_fired_at TEXT, last_key TEXT);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, rule_id INTEGER,
  title TEXT NOT NULL, body TEXT, link TEXT, severity TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at);

-- Fila de envio para canais externos (e-mail, Telegram) com retentativas.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER NOT NULL, channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, sent_at TEXT, error TEXT, created_at TEXT NOT NULL,
  UNIQUE (alert_id, channel)
);

-- Fatos novos que o motor de alertas ainda precisa avaliar (desacopla coleta de alerta).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, ref TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorites (kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, ref));

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  ok INTEGER, error TEXT, info TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs ON job_runs (job, started_at);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO currencies (code, name, pair, active, core) VALUES (?, ?, ?, ?, ?)');
  for (const c of CATALOG) ins.run(c.code, c.name, c.pair, c.core ? 1 : 0, c.core ? 1 : 0);
  return db;
}

const deepMerge = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
};

export function getPrefs(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'prefs'").get();
  return deepMerge(DEFAULT_PREFS, row ? JSON.parse(row.value) : {});
}

export function setPrefs(db, prefs) {
  const merged = deepMerge(DEFAULT_PREFS, prefs);
  db.prepare("INSERT INTO settings (key, value) VALUES ('prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(merged));
  return merged;
}

/** Executa fn dentro de uma transação. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
