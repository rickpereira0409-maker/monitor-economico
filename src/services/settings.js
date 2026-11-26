import { createHash } from 'node:crypto';
import { getPrefs, setPrefs } from '../db.js';
import { addRule } from '../alerts/engine.js';
import { byCode } from '../config/currencies.js';

/**
 * Aplica config/settings.json ao banco (modo GitHub Actions, sem painel de edição).
 * Regras são identificadas pelo NOME: atualizar parâmetros preserva o estado (rearme, intervalo) da regra.
 */
export function applySettings(db, s, now = new Date()) {
  const out = { rules: 0, deadlines: 0 };

  if (Array.isArray(s.currencies)) {
    const want = new Set(s.currencies.filter((c) => byCode[c]));
    for (const row of db.prepare('SELECT code FROM currencies').all()) db.prepare('UPDATE currencies SET active = ? WHERE code = ?').run(want.has(row.code) ? 1 : 0, row.code);
  }

  const patch = {};
  for (const k of ['delivery', 'channels', 'digest', 'profile']) if (s[k]) patch[k] = s[k];
  if (Object.keys(patch).length) setPrefs(db, mergePrefs(getPrefs(db), patch));

  if (Array.isArray(s.rules)) {
    const names = new Set();
    for (const r of s.rules) {
      if (!r.name || !r.type) continue;
      names.add(r.name);
      const row = db.prepare('SELECT id FROM alert_rules WHERE name = ?').get(r.name);
      if (row) db.prepare('UPDATE alert_rules SET type = ?, params = ?, channels = ?, cooldown_min = ?, enabled = ? WHERE id = ?')
        .run(r.type, JSON.stringify(r.params || {}), JSON.stringify(r.channels || ['inapp']), r.cooldown_min ?? 60, r.enabled === false ? 0 : 1, row.id);
      else addRule(db, r, now);
      out.rules++;
    }
    for (const row of db.prepare('SELECT id, name FROM alert_rules').all()) {
      if (names.has(row.name)) continue;
      db.prepare('DELETE FROM alert_rules WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM rule_state WHERE rule_id = ?').run(row.id);
    }
  }

  if (Array.isArray(s.deadlines)) {
    const refs = new Set();
    for (const d of s.deadlines) {
      if (!d.title || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) continue;
      const ref = createHash('sha1').update(`${d.title}|${d.date}`).digest('hex').slice(0, 16);
      refs.add(ref);
      db.prepare(`INSERT INTO deadlines (title, date, kind, description, source_url, origin, ref) VALUES (?, ?, ?, ?, ?, 'config', ?)
        ON CONFLICT (origin, ref) DO UPDATE SET kind = excluded.kind, description = excluded.description, source_url = excluded.source_url`)
        .run(d.title, d.date, d.kind || 'prazo', d.description || null, /^https?:\/\//.test(d.sourceUrl || '') ? d.sourceUrl : null, ref);
      out.deadlines++;
    }
    for (const row of db.prepare("SELECT id, ref FROM deadlines WHERE origin = 'config'").all()) if (!refs.has(row.ref)) db.prepare('DELETE FROM deadlines WHERE id = ?').run(row.id);
  }
  return out;
}

function mergePrefs(cur, patch) {
  const out = structuredClone(cur);
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  for (const k of ['daily', 'weekly']) if (patch.digest?.[k]) out.digest[k] = { ...cur.digest[k], ...patch.digest[k] };
  if (patch.channels) for (const c of Object.keys(patch.channels)) out.channels[c] = { ...cur.channels[c], ...patch.channels[c] };
  return out;
}
