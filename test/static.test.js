import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getPrefs, setPrefs } from '../src/db.js';
import { applySettings } from '../src/services/settings.js';
import { createStaticApi, filterNews, filterLegis, applyLive, livePairs, marketStatusClient } from '../public/static-api.js';
import { flushOutbox, formatMessage } from '../src/alerts/channels.js';
import { createAlert } from '../src/alerts/engine.js';

const NOW = new Date('2026-11-25T15:00:00Z');
const settings = () => ({
  currencies: ['USD', 'EUR'], delivery: { startHour: 7, endHour: 23, minIntervalMin: 15 }, channels: { ntfy: { enabled: true } },
  rules: [
    { name: 'A', type: 'news', params: { minLevel: 'alta' }, channels: ['inapp', 'ntfy'], cooldown_min: 0 },
    { name: 'B', type: 'price_above', params: { code: 'USD', rate_type: 'comercial', value: 6 }, channels: ['ntfy'], cooldown_min: 30 },
  ],
  deadlines: [{ title: 'DAS', date: '2026-12-20', sourceUrl: 'https://gov.br/x' }, { title: 'inválido', date: 'amanhã' }],
});

test('applySettings: moedas, preferências, regras por nome (preserva estado) e prazos', () => {
  const db = openDb(':memory:');
  assert.deepEqual(applySettings(db, settings(), NOW), { rules: 2, deadlines: 1 });
  assert.deepEqual(db.prepare('SELECT code FROM currencies WHERE active = 1 ORDER BY code').all().map((r) => r.code), ['EUR', 'USD']);
  assert.equal(getPrefs(db).channels.ntfy.enabled, true);
  assert.equal(getPrefs(db).delivery.startHour, 7);
  const idB = db.prepare("SELECT id FROM alert_rules WHERE name = 'B'").get().id;
  db.prepare('INSERT INTO rule_state (rule_id, armed) VALUES (?, 0)').run(idB);

  const s2 = settings(); s2.rules[1].params.value = 6.5; s2.rules.shift(); s2.deadlines = [];
  applySettings(db, s2, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alert_rules').get().n, 1, 'regra removida do arquivo some do banco');
  const b = db.prepare("SELECT id, params FROM alert_rules WHERE name = 'B'").get();
  assert.equal(b.id, idB, 'mesma regra: id preservado');
  assert.equal(JSON.parse(b.params).value, 6.5);
  assert.equal(db.prepare('SELECT armed FROM rule_state WHERE rule_id = ?').get(idB).armed, 0, 'estado de rearme preservado');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deadlines WHERE origin = 'config'").get().n, 0);
  applySettings(db, settings(), NOW); applySettings(db, settings(), NOW);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deadlines WHERE origin = 'config'").get().n, 1, 'idempotente');
});

test('ntfy: vai para a fila, respeita janela de horário e o clique aponta para o painel', async () => {
  const db = openDb(':memory:');
  setPrefs(db, { channels: { ntfy: { enabled: true } }, delivery: { startHour: 7, endHour: 23, minIntervalMin: 0 } });
  createAlert(db, { kind: 'cambio', dedupeKey: 'a', title: 'USD/BRL acima de R$ 6,00', body: 'Cotação de mercado', link: '#/moedas', channels: ['inapp', 'ntfy'], now: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel = 'ntfy'").get().n, 1);
  const calls = [];
  const sender = { send: async (ch, msg) => calls.push({ ch, msg }) };
  const night = new Date('2026-11-26T04:00:00Z'); // 01:00 em Brasília
  assert.equal((await flushOutbox(db, night, sender, { ntfy: true })).held, 1);
  assert.equal((await flushOutbox(db, NOW, sender, { ntfy: true })).sent, 1);
  assert.equal(calls[0].ch, 'ntfy');
  process.env.PUBLIC_URL = 'https://rick.github.io/monitor/';
  const m = formatMessage([{ title: 'Selic é elevada', body: 'corpo', link: '#/alertas' }]);
  assert.equal(m.click, 'https://rick.github.io/monitor/#/alertas');
});

test('ntfy real: POST JSON ao servidor com o tópico (fetch simulado)', async () => {
  const { realSender } = await import('../src/alerts/channels.js');
  const { config } = await import('../src/config.js');
  config.ntfy.topic = 'topico-teste-123';
  const orig = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200 }; };
  try { await realSender.send('ntfy', { subject: '[Monitor] Dólar sobe 1,2%', text: 'detalhe ção', click: 'https://x.io' }, {}); } finally { globalThis.fetch = orig; }
  assert.equal(seen.url, 'https://ntfy.sh');
  assert.equal(seen.body.topic, 'topico-teste-123');
  assert.equal(seen.body.title, 'Dólar sobe 1,2%');
  assert.equal(seen.body.click, 'https://x.io');
});

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const files = {
  'data/alerts.json': { unread: 2, alerts: [{ id: 1, kind: 'noticia', read: false }, { id: 2, kind: 'cambio', read: false }] },
  'data/status.json': { generatedAt: NOW.toISOString(), jobs: [], channels: {} },
  'data/news.json': [{ id: 1, title: 'Selic sobe', summary: '', level: 'alta', direction: 'baixa', topics: ['juros_br'], official: false }, { id: 2, title: 'Dólar cai', summary: 'x', level: 'media', direction: 'incerto', topics: ['cambio'], official: true }],
  'data/legislation.json': [
    { id: 'a', curated: true, stage: 'proposta', regimes: ['todos'], setores: ['todos'], ufs: ['todas'] },
    { id: 'b', curated: true, stage: 'proposta', regimes: ['MEI'], setores: ['todos'], ufs: ['todas'] },
    { id: 'c', curated: false, stage: 'comissao', regimes: ['indeterminado'], setores: ['indeterminado'], ufs: ['indeterminado'] },
  ],
};
const mkApi = () => createStaticApi({ fetchJson: async (u) => { if (!files[u]) throw new Error('404 ' + u); return structuredClone(files[u]); }, storage: mem() });

test('API estática: favoritos e leitura de alertas ficam no aparelho; escrita no servidor é recusada', async () => {
  const api = mkApi();
  assert.equal((await api('/status')).unreadAlerts, 2);
  await api('/alerts/1/read', { method: 'POST' });
  assert.equal((await api('/status')).unreadAlerts, 1);
  assert.equal((await api('/alerts?unread=1')).alerts.length, 1);
  await api('/alerts/read-all', { method: 'POST' });
  assert.equal((await api('/alerts')).unread, 0);
  await api('/favorites', { method: 'POST', body: { kind: 'news', ref: '2', on: true } });
  assert.deepEqual(await api('/favorites'), [{ kind: 'news', ref: '2' }]);
  assert.deepEqual((await api('/news?favorites=1')).map((n) => n.id), [2]);
  await assert.rejects(() => api('/rules', { method: 'POST', body: {} }), /Somente leitura/);
  await assert.rejects(() => api('/rota-inexistente'), /Rota não encontrada/);
});

test('filtros do modo estático iguais aos do servidor', () => {
  const none = new Set();
  assert.deepEqual(filterNews(files['data/news.json'], { level: 'alta' }, none).map((n) => n.id), [1]);
  assert.deepEqual(filterNews(files['data/news.json'], { official: '1' }, none).map((n) => n.id), [2]);
  assert.deepEqual(filterNews(files['data/news.json'], { q: 'DÓLAR' }, none).map((n) => n.id), [2]);
  const L = files['data/legislation.json'];
  const ids = (q) => filterLegis(L, q, none).map((x) => `${x.id}:${x.applies}`).sort();
  assert.deepEqual(ids({ regime: 'MEI' }), ['a:sim', 'b:sim', 'c:indeterminado']);
  assert.deepEqual(ids({ regime: 'MEI', hideUndetermined: '1' }), ['a:sim', 'b:sim']);
  assert.deepEqual(ids({ regime: 'Lucro Real' }), ['a:sim', 'c:indeterminado']);
  assert.deepEqual(ids({ onlyCurated: '1', stage: 'proposta' }), ['a:sim', 'b:sim']);
});

test('cotação ao vivo: só substitui se for mais nova, recalcula variação e não mexe na PTAX', () => {
  const data = { currencies: [{ code: 'USD', active: true, hasTourism: true, types: [
    { type: 'ptax', available: true, value: 5.88, quoteTs: '2026-11-25T16:00:00.000Z', prevClose: 5.85 },
    { type: 'comercial', available: true, value: 5.82, quoteTs: '2026-11-25T22:00:00.000Z', prevClose: 5.90, stale: true },
    { type: 'turismo', available: true, value: 6.2, quoteTs: '2026-11-25T22:00:00.000Z', prevClose: 6.3 }] }] };
  assert.deepEqual(livePairs(data), ['USD-BRL', 'USD-BRLT']);
  const ts = Date.parse('2026-11-25T22:30:00Z') / 1000;
  const n = applyLive(data, { USDBRL: { bid: '5.9000', ask: '5.9100', timestamp: String(ts) }, USDBRLT: { bid: '5', ask: '6.3', timestamp: String(ts - 100000) } }, ts * 1000);
  assert.equal(n, 1);
  const [ptax, com, tur] = data.currencies[0].types;
  assert.equal(com.value, 5.9); assert.equal(com.changePct, 0); assert.equal(com.stale, false); assert.equal(com.live, true);
  assert.equal(ptax.value, 5.88); assert.equal(tur.value, 6.2, 'cotação mais velha é ignorada');
  assert.equal(marketStatusClient(new Date('2026-11-25T15:00:00Z')).open, true);
  assert.equal(marketStatusClient(new Date('2026-11-28T15:00:00Z')).open, false);
});
