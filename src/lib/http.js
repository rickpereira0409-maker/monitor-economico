import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET com timeout, tentativas e espera exponencial com jitter. Lança erro após esgotar as tentativas. */
export async function fetchRetry(url, { retries = 3, timeoutMs = 15000, headers = {}, baseDelayMs = 800, as = 'text' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent, Accept: '*/*', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.noRetry = true; throw e; }
      return as === 'json' ? await res.json() : await res.text();
    } catch (err) {
      lastErr = err;
      if (err.noRetry || attempt === retries) break;
      await sleep(baseDelayMs * 2 ** attempt + Math.random() * 300);
    }
  }
  throw new Error(`Falha ao acessar ${new URL(url).host}: ${lastErr?.message || lastErr}`);
}
