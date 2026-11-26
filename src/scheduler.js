import { fmtSP } from './lib/time.js';

/**
 * Agendador simples em processo: cada tarefa roda em intervalo próprio, sem sobreposição.
 * Em falha, repete mais cedo com espera crescente (1, 2, 4... min, no máximo o próprio intervalo) e registra tudo em job_runs.
 */
export function createScheduler(db, jobs, { log = console.log } = {}) {
  const timers = new Map();
  const running = new Set();
  const fails = new Map();
  let stopped = false;

  async function run(job) {
    if (stopped || running.has(job.name)) return;
    running.add(job.name);
    const started = new Date();
    const id = Number(db.prepare('INSERT INTO job_runs (job, started_at) VALUES (?, ?)').run(job.name, started.toISOString()).lastInsertRowid);
    let ok = true, info = null, error = null;
    try { info = await job.run(started); } catch (e) { ok = false; error = String(e.message || e).slice(0, 500); }
    db.prepare('UPDATE job_runs SET finished_at = ?, ok = ?, error = ?, info = ? WHERE id = ?').run(new Date().toISOString(), ok ? 1 : 0, error, info == null ? null : JSON.stringify(info).slice(0, 1500), id);
    running.delete(job.name);
    const n = ok ? 0 : (fails.get(job.name) || 0) + 1;
    fails.set(job.name, n);
    if (!ok) log(`[${fmtSP(new Date())}] tarefa ${job.name} falhou (${n}ª seguida): ${error}`);
    const delay = ok ? job.everyMs : Math.min(job.everyMs, 60000 * 2 ** (n - 1));
    if (!stopped) timers.set(job.name, setTimeout(() => run(job), delay));
  }

  return {
    start() { for (const job of jobs) timers.set(job.name, setTimeout(() => run(job), job.startDelayMs ?? 0)); },
    stop() { stopped = true; for (const t of timers.values()) clearTimeout(t); },
    runNow: (name) => run(jobs.find((j) => j.name === name)),
  };
}

/** Estado das tarefas, para o painel mostrar quais fontes estão falhando ou desatualizadas. */
export function jobStatus(db, jobs, now = new Date()) {
  return jobs.map((j) => {
    const last = db.prepare('SELECT * FROM job_runs WHERE job = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(j.name);
    const lastOk = db.prepare('SELECT finished_at FROM job_runs WHERE job = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(j.name);
    let consecutiveFailures = 0;
    for (const r of db.prepare('SELECT ok FROM job_runs WHERE job = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 20').all(j.name)) { if (r.ok) break; consecutiveFailures++; }
    const ageMs = lastOk ? now - new Date(lastOk.finished_at) : null;
    const stale = ageMs == null ? true : ageMs > j.everyMs * 3 + 120000;
    return {
      name: j.name, label: j.label, everyMin: Math.round(j.everyMs / 60000), lastRunAt: last?.finished_at ?? null, lastOkAt: lastOk?.finished_at ?? null,
      lastError: last && !last.ok ? last.error : null, consecutiveFailures, stale,
    };
  });
}
