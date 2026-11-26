import { config, channelAvailability } from '../config.js';
import { getPrefs } from '../db.js';
import { inDeliveryWindow } from './engine.js';
import { fmtSP } from '../lib/time.js';

const MAX_ATTEMPTS = 5;
const BATCH_MAX = 10;

/** Formata um ou mais alertas em uma única mensagem de texto. */
export function formatMessage(alerts) {
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  let firstLink = '';
  const one = (a) => {
    const link = a.link?.startsWith('#') ? (publicUrl ? `${publicUrl}/${a.link}` : '') : a.link || '';
    firstLink ||= link;
    return `${a.title}\n${a.body || ''}${link ? `\n${link}` : ''}`.trim();
  };
  if (alerts.length === 1) { const text = one(alerts[0]); return { subject: `[Monitor] ${alerts[0].title}`.slice(0, 150), text, click: firstLink || undefined }; }
  const shown = alerts.slice(0, BATCH_MAX);
  const extra = alerts.length - shown.length;
  return {
    subject: `[Monitor] ${alerts.length} novos alertas`,
    text: shown.map((a, i) => `${i + 1}. ${one(a)}`).join('\n\n') + (extra > 0 ? `\n\n…e mais ${extra} alertas no painel.` : ''),
    click: publicUrl || undefined,
  };
}

/** Envio real. Credenciais vêm apenas de variáveis de ambiente (servidor). */
export const realSender = {
  async send(channel, msg, prefs) {
    if (channel === 'email') {
      const to = prefs.channels.email.to;
      if (!to) throw new Error('E-mail de destino não configurado');
      const { default: nodemailer } = await import('nodemailer');
      const s = config.smtp;
      const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined });
      await transport.sendMail({ from: s.from, to, subject: msg.subject, text: msg.text });
      return;
    }
    if (channel === 'telegram') {
      const chatId = prefs.channels.telegram.chatId;
      if (!chatId) throw new Error('Chat ID do Telegram não configurado');
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ chat_id: chatId, text: msg.text.slice(0, 4000), disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(`Telegram: ${body.description || res.status}`);
      return;
    }
    if (channel === 'ntfy') {
      const { server, topic } = config.ntfy;
      if (!topic) throw new Error('NTFY_TOPIC não configurado');
      // Publicação em JSON: aceita acentos no título e na mensagem sem codificar cabeçalhos.
      const res = await fetch(server, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ topic, title: msg.subject.replace(/^\[Monitor\] /, '').slice(0, 200), message: msg.text.slice(0, 3800), click: msg.click || undefined, priority: msg.priority || 3, tags: ['chart_with_upwards_trend'] }),
      });
      if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
      return;
    }
    throw new Error(`Canal desconhecido: ${channel}`);
  },
};

/**
 * Esvazia a fila de envio respeitando: janela de horário de recebimento, intervalo mínimo entre mensagens
 * (alertas comuns acumulados saem juntos em uma única mensagem) e retentativas com espera crescente.
 * Resumos (digest) saem individualmente e não esperam o intervalo mínimo, mas respeitam a janela de horário.
 */
export async function flushOutbox(db, now = new Date(), sender = realSender, available = channelAvailability()) {
  const prefs = getPrefs(db);
  const result = { sent: 0, failed: 0, held: 0, skipped: 0 };
  for (const channel of ['email', 'telegram', 'ntfy']) {
    const pendingAll = db.prepare(`SELECT o.id AS oid, o.attempts, a.kind, a.title, a.body, a.link FROM outbox o JOIN alerts a ON a.id = o.alert_id
      WHERE o.channel = ? AND o.status = 'pending' AND o.next_attempt_at <= ? ORDER BY o.id`).all(channel, now.toISOString());
    if (!pendingAll.length) continue;

    if (!prefs.channels[channel]?.enabled || !available[channel]) {
      for (const r of pendingAll) db.prepare("UPDATE outbox SET status = 'skipped', error = ? WHERE id = ?").run(!available[channel] ? 'Canal sem credenciais no servidor' : 'Canal desativado', r.oid);
      result.skipped += pendingAll.length;
      continue;
    }
    if (!inDeliveryWindow(prefs.delivery, now)) { result.held += pendingAll.length; continue; }

    const digests = pendingAll.filter((r) => r.kind === 'resumo');
    const normal = pendingAll.filter((r) => r.kind !== 'resumo');
    const groups = digests.map((r) => [r]);
    const last = db.prepare("SELECT MAX(sent_at) s FROM outbox WHERE channel = ? AND status = 'sent' AND alert_id NOT IN (SELECT id FROM alerts WHERE kind = 'resumo')").get(channel).s;
    const gap = (prefs.delivery.minIntervalMin || 0) * 60000;
    if (normal.length) {
      if (!last || now - new Date(last) >= gap) groups.push(normal.slice(0, 50));
      else result.held += normal.length;
    }

    for (const g of groups) {
      try {
        await sender.send(channel, formatMessage(g), prefs);
        for (const r of g) db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(now.toISOString(), r.oid);
        result.sent += g.length;
      } catch (e) {
        for (const r of g) {
          const attempts = r.attempts + 1;
          const fatal = attempts >= MAX_ATTEMPTS;
          const next = new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60000).toISOString();
          db.prepare('UPDATE outbox SET attempts = ?, status = ?, next_attempt_at = ?, error = ? WHERE id = ?').run(attempts, fatal ? 'failed' : 'pending', next, String(e.message).slice(0, 300), r.oid);
        }
        result.failed += g.length;
      }
    }
  }
  return result;
}
