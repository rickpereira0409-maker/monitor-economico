import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { config, channelAvailability } from './config.js';
import { openDb, getPrefs, setPrefs, DEFAULT_PREFS } from './db.js';
import { buildJobs } from './jobs.js';
import { createScheduler, jobStatus } from './scheduler.js';
import { currenciesView, historyView, newsView, legislationView, legislationDetail, agendaView, alertsView } from './services/views.js';
import { ensureDefaultRules, addRule, RULE_TYPES } from './alerts/engine.js';
import { realSender, formatMessage } from './alerts/channels.js';
import { byCode, CATALOG } from './config/currencies.js';
import { buildMeta } from './services/meta.js';
import { TOPIC_LIST } from './analysis/news.js';
import { STAGES } from './analysis/legislation.js';
import { marketStatus } from './lib/fx.js';
import { spDate } from './lib/time.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const IS_PROD = config.nodeEnv === 'production';

// ---------- Segurança: segredo de sessão, senha, cookies ----------
if (IS_PROD && (!config.accessPassword || config.accessPassword.length < 8)) { console.error('ERRO: defina ACCESS_PASSWORD (mínimo 8 caracteres) em produção.'); process.exit(1); }
if (IS_PROD && config.sessionSecret.length < 32) { console.error('ERRO: defina SESSION_SECRET com pelo menos 32 caracteres em produção.'); process.exit(1); }
const SECRET = config.sessionSecret || randomBytes(32).toString('hex');
const AUTH_ON = !!config.accessPassword;
if (!AUTH_ON) console.warn('AVISO: ACCESS_PASSWORD não definido. Painel SEM senha (aceitável só em uso local).');

const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));
const sign = (v) => createHmac('sha256', SECRET).update(v).digest('base64url');
const SESSION_MS = 7 * 86400e3;

function makeSession() { const exp = String(Date.now() + SESSION_MS); return `${exp}.${sign(exp)}`; }
function validSession(tok) {
  const [exp, sig] = String(tok || '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const clientIp = (req) => (process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

const attempts = new Map(); // limite de tentativas de login por IP
function loginAllowed(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60000);
  attempts.set(ip, a);
  return a.length < 8;
}

// ---------- Utilidades HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 100_000) throw new HttpError(413, 'Corpo da requisição muito grande'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

// ---------- Validação de entradas ----------
const clampInt = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : d);
const CHANNELS = ['inapp', 'email', 'telegram', 'ntfy'];
const cleanChannels = (c) => { const l = (Array.isArray(c) ? c : ['inapp']).filter((x) => CHANNELS.includes(x)); return l.length ? [...new Set(l)] : ['inapp']; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null; } catch { return null; } };

export function validateRule(b) {
  const type = b.type;
  if (!RULE_TYPES[type]) throw new HttpError(400, 'Tipo de regra inválido');
  const p = b.params || {};
  const out = { type, name: str(b.name, 120) || RULE_TYPES[type], channels: cleanChannels(b.channels), cooldown_min: clampInt(b.cooldown_min, 0, 1440, 60), params: {} };
  if (type === 'price_above' || type === 'price_below' || type === 'pct_move') {
    if (!byCode[p.code]) throw new HttpError(400, 'Moeda inválida');
    const rt = ['ptax', 'comercial', 'turismo'].includes(p.rate_type) ? p.rate_type : 'comercial';
    if (rt === 'ptax' && !byCode[p.code].ptax) throw new HttpError(400, 'Esta moeda não tem PTAX');
    out.params = { code: p.code, rate_type: rt };
    if (type === 'pct_move') {
      const pct = +p.pct, win = clampInt(p.windowMin, 5, 10080, 60);
      if (!(pct >= 0.1 && pct <= 50)) throw new HttpError(400, 'Informe a variação percentual entre 0,1 e 50');
      out.params.pct = pct; out.params.windowMin = win;
    } else {
      if (!(+p.value > 0)) throw new HttpError(400, 'Informe um valor maior que zero');
      out.params.value = +p.value;
    }
  } else if (type === 'news') {
    out.params = { minLevel: ['alta', 'media'].includes(p.minLevel) ? p.minLevel : 'alta', topics: (p.topics || []).filter((t) => TOPIC_LIST.some((x) => x.id === t)), directions: (p.directions || []).filter((d) => ['alta', 'baixa', 'incerto'].includes(d)) };
  } else if (type === 'legis') {
    out.params = { mode: p.mode === 'any' ? 'any' : 'stage', onlyCurated: p.onlyCurated !== false, itemIds: (p.itemIds || []).map((x) => str(x, 40)).slice(0, 50) };
  } else if (type === 'deadline') {
    out.params = { daysBefore: [...new Set((p.daysBefore || [7, 3, 1, 0]).map((d) => clampInt(d, 0, 365, 0)))].sort((a, b) => b - a).slice(0, 8) };
  }
  return out;
}

export function validatePrefs(b, current) {
  const p = structuredClone(current);
  const d = b.delivery || {};
  if (b.delivery) p.delivery = { startHour: clampInt(d.startHour, 0, 23, 8), endHour: clampInt(d.endHour, 0, 24, 20), weekdaysOnly: !!d.weekdaysOnly, minIntervalMin: clampInt(d.minIntervalMin, 0, 1440, 30) };
  if (b.channels?.email) {
    const to = str(b.channels.email.to, 200);
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'E-mail inválido');
    p.channels.email = { enabled: !!b.channels.email.enabled, to };
  }
  if (b.channels?.telegram) {
    const chatId = str(b.channels.telegram.chatId, 40);
    if (chatId && !/^(-?\d{3,20}|@[A-Za-z0-9_]{4,64})$/.test(chatId)) throw new HttpError(400, 'Chat ID do Telegram inválido');
    p.channels.telegram = { enabled: !!b.channels.telegram.enabled, chatId };
  }
  if (b.channels?.ntfy) p.channels.ntfy = { enabled: !!b.channels.ntfy.enabled };
  for (const k of ['daily', 'weekly']) {
    const x = b.digest?.[k];
    if (x) p.digest[k] = { ...p.digest[k], enabled: !!x.enabled, hour: clampInt(x.hour, 0, 23, 8), channels: cleanChannels(x.channels), ...(k === 'weekly' ? { weekday: clampInt(x.weekday, 0, 6, 1) } : {}) };
  }
  if (b.profile) p.profile = { regime: str(b.profile.regime, 40), setor: str(b.profile.setor, 60), uf: str(b.profile.uf, 2).toUpperCase() };
  return p;
}

// ---------- Aplicação ----------
export function createApp(db, jobs) {
  const sched = jobStatus;
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  add('GET', '/api/status', (ctx) => {
    const now = new Date();
    return {
      now: now.toISOString(), today: spDate(now), timezone: 'America/Sao_Paulo', market: marketStatus(now), channels: channelAvailability(),
      jobs: sched(db, jobs, now), authRequired: AUTH_ON, unreadAlerts: db.prepare('SELECT COUNT(*) n FROM alerts WHERE read = 0').get().n,
      demo: db.prepare('SELECT (SELECT COUNT(*) FROM news WHERE is_demo=1) + (SELECT COUNT(*) FROM alerts WHERE is_demo=1) + (SELECT COUNT(*) FROM deadlines WHERE is_demo=1) AS n').get().n > 0,
    };
  });
  add('GET', '/api/meta', () => buildMeta());

  add('GET', '/api/currencies', () => currenciesView(db));
  add('GET', '/api/currencies/:code/history', ({ params, query }) => {
    const h = historyView(db, params.code.toUpperCase(), query.get('type') || 'comercial', query.get('range') || '30d');
    if (!h) throw new HttpError(404, 'Moeda ou tipo de cotação inválido');
    return h;
  });
  add('POST', '/api/currencies/:code/active', ({ params, body }) => {
    const code = params.code.toUpperCase();
    if (!byCode[code]) throw new HttpError(404, 'Moeda desconhecida');
    db.prepare('UPDATE currencies SET active = ? WHERE code = ?').run(body.active ? 1 : 0, code);
    if (body.active) setImmediate(() => { Promise.resolve(jobsByName.fx_backfill?.run(new Date())).then(() => jobsByName.fx_market?.run(new Date())).catch(() => {}); });
    return { ok: true };
  });

  add('GET', '/api/news', ({ query }) => newsView(db, Object.fromEntries(query)));
  add('GET', '/api/legislation', ({ query }) => legislationView(db, Object.fromEntries(query)));
  add('GET', '/api/legislation/:id/events', ({ params }) => legislationDetail(db, decodeURIComponent(params.id)));
  add('GET', '/api/agenda', () => agendaView(db));

  add('POST', '/api/deadlines', ({ body }) => {
    const title = str(body.title, 160), date = str(body.date, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Informe título e data válida');
    const url = body.sourceUrl ? safeUrl(body.sourceUrl) : null;
    if (body.sourceUrl && !url) throw new HttpError(400, 'Link da fonte inválido (use http ou https)');
    const info = db.prepare('INSERT INTO deadlines (title, date, kind, description, source_url, origin) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, date, ['prazo', 'obrigacao', 'vigencia', 'evento'].includes(body.kind) ? body.kind : 'prazo', str(body.description, 600) || null, url, 'usuario');
    return { id: Number(info.lastInsertRowid) };
  });
  add('DELETE', '/api/deadlines/:id', ({ params }) => { db.prepare("DELETE FROM deadlines WHERE id = ? AND origin = 'usuario'").run(+params.id); return { ok: true }; });

  add('GET', '/api/alerts', ({ query }) => alertsView(db, Object.fromEntries(query)));
  add('POST', '/api/alerts/read-all', () => { db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run(); return { ok: true }; });
  add('POST', '/api/alerts/:id/read', ({ params, body }) => { db.prepare('UPDATE alerts SET read = ? WHERE id = ?').run(body.read === false ? 0 : 1, +params.id); return { ok: true }; });

  add('GET', '/api/rules', () => ({
    rules: db.prepare('SELECT * FROM alert_rules ORDER BY id').all().map((r) => ({ id: r.id, type: r.type, name: r.name, params: JSON.parse(r.params), channels: JSON.parse(r.channels), cooldownMin: r.cooldown_min, enabled: !!r.enabled })),
  }));
  add('POST', '/api/rules', ({ body }) => ({ id: addRule(db, validateRule(body)) }));
  add('PUT', '/api/rules/:id', ({ params, body }) => {
    const cur = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(+params.id);
    if (!cur) throw new HttpError(404, 'Regra não encontrada');
    if (Object.keys(body).length === 1 && 'enabled' in body) { db.prepare('UPDATE alert_rules SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, cur.id); return { ok: true }; }
    const r = validateRule(body);
    db.prepare('UPDATE alert_rules SET type = ?, name = ?, params = ?, channels = ?, cooldown_min = ?, enabled = ? WHERE id = ?').run(r.type, r.name, JSON.stringify(r.params), JSON.stringify(r.channels), r.cooldown_min, body.enabled === false ? 0 : 1, cur.id);
    db.prepare('DELETE FROM rule_state WHERE rule_id = ?').run(cur.id);
    return { ok: true };
  });
  add('DELETE', '/api/rules/:id', ({ params }) => { db.prepare('DELETE FROM alert_rules WHERE id = ?').run(+params.id); db.prepare('DELETE FROM rule_state WHERE rule_id = ?').run(+params.id); return { ok: true }; });

  add('GET', '/api/prefs', () => getPrefs(db));
  add('PUT', '/api/prefs', ({ body }) => setPrefs(db, validatePrefs(body, getPrefs(db))));

  add('GET', '/api/favorites', () => db.prepare('SELECT kind, ref FROM favorites').all());
  add('POST', '/api/favorites', ({ body }) => {
    if (!['currency', 'news', 'legis'].includes(body.kind) || !body.ref) throw new HttpError(400, 'Favorito inválido');
    if (body.on) db.prepare('INSERT OR IGNORE INTO favorites (kind, ref, created_at) VALUES (?, ?, ?)').run(body.kind, str(body.ref, 80), new Date().toISOString());
    else db.prepare('DELETE FROM favorites WHERE kind = ? AND ref = ?').run(body.kind, str(body.ref, 80));
    return { ok: true };
  });

  add('POST', '/api/channels/test', async ({ body }) => {
    const ch = body.channel;
    if (!['email', 'telegram', 'ntfy'].includes(ch)) throw new HttpError(400, 'Canal inválido');
    if (!channelAvailability()[ch]) throw new HttpError(400, { email: 'SMTP não configurado no servidor (SMTP_HOST, SMTP_FROM...).', telegram: 'TELEGRAM_BOT_TOKEN não configurado no servidor.', ntfy: 'NTFY_TOPIC não configurado no servidor.' }[ch]);
    try {
      await realSender.send(ch, formatMessage([{ title: 'Teste do Monitor Econômico e Tributário', body: 'Se você recebeu esta mensagem, o canal está funcionando.', link: '' }]), getPrefs(db));
      return { ok: true };
    } catch (e) { throw new HttpError(502, `Falha no envio: ${e.message}`); }
  });
  add('GET', '/api/telegram/chats', async () => {
    if (!config.telegramToken) throw new HttpError(400, 'TELEGRAM_BOT_TOKEN não configurado no servidor.');
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getUpdates`, { signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new HttpError(502, `Telegram: ${j.description || res.status}`);
    const seen = new Map();
    for (const u of j.result || []) { const c = u.message?.chat || u.channel_post?.chat; if (c) seen.set(c.id, { id: String(c.id), nome: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' }); }
    return { chats: [...seen.values()], dica: 'Se a lista estiver vazia, envie uma mensagem ao seu bot no Telegram e atualize.' };
  });

  const jobsByName = Object.fromEntries(jobs.map((j) => [j.name, j]));

  // ----- Despacho -----
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = clientIp(req);
        if (!loginAllowed(ip)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
        const body = await readJson(req);
        if (!AUTH_ON || safeEq(body.password || '', config.accessPassword)) {
          const cookie = `sid=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${config.cookieSecure ? '; Secure' : ''}`;
          return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
        }
        attempts.get(ip).push(Date.now());
        throw new HttpError(401, 'Senha incorreta');
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });

      if (url.pathname.startsWith('/api/')) {
        if (AUTH_ON && !validSession(cookies(req).sid)) throw new HttpError(401, 'Autenticação necessária');
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'monitor') throw new HttpError(403, 'Cabeçalho de segurança ausente');
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
          const out = await r.handler({ params: m.groups || {}, query: url.searchParams, body, req });
          return send(res, 200, out);
        }
        throw new HttpError(404, 'Rota não encontrada');
      }

      // Arquivos estáticos
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
      const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      const file = resolve(join(PUBLIC_DIR, rel));
      if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(403, 'Acesso negado');
      try {
        const data = await readFile(file);
        return send(res, 200, data, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
      } catch { throw new HttpError(404, 'Arquivo não encontrado'); }
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('[erro]', req.method, url.pathname, e);
      return send(res, 500, { error: 'Erro interno do servidor' });
    }
  };
}

// ---------- Inicialização ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const db = openDb(config.dbPath);
  ensureDefaultRules(db);
  const jobs = buildJobs(db);
  const server = createServer(createApp(db, jobs));
  server.listen(config.port, () => console.log(`Monitor em http://localhost:${config.port} (${config.nodeEnv}) — coletas agendadas iniciando…`));
  const scheduler = createScheduler(db, jobs);
  scheduler.start();
  const stop = () => { scheduler.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
