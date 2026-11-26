import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ACCESS_PASSWORD = 'senha-de-teste-123';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.DB_PATH = ':memory:';
const { createApp, validateRule, validatePrefs } = await import('../src/server.js');
const { openDb, getPrefs } = await import('../src/db.js');
const { buildJobs } = await import('../src/jobs.js');

const db = openDb(':memory:');
const server = createServer(createApp(db, buildJobs(db)));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
});

test('API exige autenticação; login com senha errada falha e a certa devolve cookie seguro', async () => {
  assert.equal((await call('/api/status')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'errada' } })).status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const sid = cookie.split(';')[0];
  assert.equal((await call('/api/status', { cookie: sid })).status, 200);
  assert.equal((await call('/api/status', { cookie: 'sid=1.assinatura-falsa' })).status, 401);
  const exp = `${Date.now() + 1e6}.${'a'.repeat(43)}`;
  assert.equal((await call('/api/status', { cookie: `sid=${exp}` })).status, 401);
});

test('mutações exigem o cabeçalho anti-CSRF; cabeçalhos de segurança presentes', async () => {
  const ok = await call('/api/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const sem = await call('/api/favorites', { method: 'POST', body: { kind: 'news', ref: '1', on: true }, cookie });
  assert.equal(sem.status, 403);
  const com = await call('/api/favorites', { method: 'POST', body: { kind: 'news', ref: '1', on: true }, cookie, headers: { 'X-Requested-With': 'monitor' } });
  assert.equal(com.status, 200);
  const page = await call('/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('arquivos estáticos: sem travessia de diretório', async () => {
  assert.equal((await call('/../package.json')).status === 200, false);
  assert.equal((await call('/%2e%2e/package.json')).status === 200, false);
  assert.equal((await call('/..%5c..%5cpackage.json')).status === 200, false);
  assert.equal((await call('/styles.css')).status, 200);
});

test('validateRule: aceita regras válidas e rejeita entradas ruins', () => {
  const ok = validateRule({ type: 'price_above', params: { code: 'USD', rate_type: 'comercial', value: 5.9 }, channels: ['inapp', 'email', 'sms'], cooldown_min: 30 });
  assert.deepEqual(ok.channels, ['inapp', 'email']);
  assert.equal(ok.params.value, 5.9);
  assert.throws(() => validateRule({ type: 'price_above', params: { code: 'XXX', value: 1 } }), /Moeda inválida/);
  assert.throws(() => validateRule({ type: 'price_above', params: { code: 'USD', value: -1 } }), /maior que zero/);
  assert.throws(() => validateRule({ type: 'price_above', params: { code: 'CNY', rate_type: 'ptax', value: 1 } }), /não tem PTAX/);
  assert.throws(() => validateRule({ type: 'pct_move', params: { code: 'USD', pct: 0, windowMin: 60 } }), /entre 0,1 e 50/);
  assert.throws(() => validateRule({ type: 'foo' }), /inválido/);
  assert.deepEqual(validateRule({ type: 'deadline', params: { daysBefore: [1, 7, 7, 3, 999] } }).params.daysBefore, [365, 7, 3, 1]);
});

test('validatePrefs: limita horas, valida e-mail e chat id do Telegram', () => {
  const cur = getPrefs(db);
  const p = validatePrefs({ delivery: { startHour: 99, endHour: 20, minIntervalMin: -5 } }, cur);
  assert.equal(p.delivery.startHour, 23); assert.equal(p.delivery.minIntervalMin, 0);
  assert.throws(() => validatePrefs({ channels: { email: { enabled: true, to: 'nao-e-email' } } }, cur), /E-mail inválido/);
  assert.throws(() => validatePrefs({ channels: { telegram: { enabled: true, chatId: 'abc; drop' } } }, cur), /Chat ID/);
  assert.equal(validatePrefs({ channels: { telegram: { enabled: true, chatId: '-1001234567' } } }, cur).channels.telegram.chatId, '-1001234567');
});
