import process from 'node:process';

try { process.loadEnvFile('.env'); } catch { /* .env é opcional; as variáveis podem vir do ambiente */ }

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);

export const config = {
  nodeEnv: env.NODE_ENV || 'development',
  port: num(env.PORT, 3000),
  dbPath: env.DB_PATH || './data/monitor.db',
  userAgent: env.HTTP_USER_AGENT || 'MonitorEconomicoTributario/0.1 (uso interno)',

  // Acesso ao painel (obrigatório em produção)
  accessPassword: env.ACCESS_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',

  // Frequência das coletas (minutos)
  intervals: {
    fxMarket: num(env.FX_MARKET_INTERVAL_MIN, 5),
    fxPtax: num(env.FX_PTAX_INTERVAL_MIN, 30),
    news: num(env.NEWS_INTERVAL_MIN, 20),
    legislation: num(env.LEGISLATION_INTERVAL_MIN, 60),
    alerts: num(env.ALERTS_INTERVAL_MIN, 1),
  },

  awesomeApiKey: env.AWESOMEAPI_KEY || '',

  smtp: {
    host: env.SMTP_HOST || '', port: num(env.SMTP_PORT, 587), secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  ntfy: { server: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), topic: env.NTFY_TOPIC || '' },
};

export const channelAvailability = () => ({
  email: !!(config.smtp.host && config.smtp.from),
  telegram: !!config.telegramToken,
  ntfy: !!config.ntfy.topic,
});
