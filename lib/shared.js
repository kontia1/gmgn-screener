/**
 * Shared GMGN + Telegram utilities
 */
const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env
const ENV_FILE = path.join(__dirname, '..', '.env');
try {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

// Telegram config: env vars first, fallback to config/telegram.json
let tgConfig = {};
try {
  tgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'telegram.json'), 'utf8'));
} catch {}
const BOT_TOKEN = process.env.BOT_TOKEN || tgConfig.botToken;
const CHAT_ID = process.env.CHAT_ID || tgConfig.chatId;

// ─── GMGN CLI (async, with timeout + kill) ───────────
function gmgnAsync(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const proc = exec(`gmgn-cli ${cmd}`, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
    // Force kill on timeout
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs + 500);
  });
}

// GMGN CLI (sync, for scanner — with timeout)
function gmgn(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(`gmgn-cli ${cmd}`, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function gmgnTokenInfo(address) { return gmgnAsync(`token info --chain sol --address ${address}`); }
function gmgnTokenPool(address) { return gmgnAsync(`token pool --chain sol --address ${address}`); }

async function gmgnLastTx(address) {
  const data = await gmgnAsync(`market kline --chain sol --address ${address} --resolution 1m`);
  const list = data?.list || [];
  const last = list[list.length - 1];
  if (!last) return null;
  return { ageSec: Math.floor(Date.now() / 1000 - last.time / 1000), vol: parseFloat(last.volume) || 0 };
}

// Sequential processing — avoid spawning too many gmgn-cli at once
async function gmgnBatch(addresses, perTokenFn) {
  const results = [];
  for (const addr of addresses) {
    const r = await perTokenFn(addr);
    results.push(r);
  }
  return results;
}

// ─── Telegram API ──────────────────────────────────────
function tgApi(method, params = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(params);
    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', (e) => { console.error('[TG]', e.message); resolve({ ok: false }); });
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(text, extraParams = {}) {
  const body = {
    chat_id: CHAT_ID, text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extraParams,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await tgApi('sendMessage', body);
    if (r.ok) { console.log('[TG] Sent'); return true; }
    if (attempt < 2) {
      const wait = (attempt + 1) * 2000;
      console.warn(`[TG] Retry ${attempt+1}/3 in ${wait/1000}s: ${r.description || r.error_code || 'unknown'}`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      const detail = r.description || r.error_code || JSON.stringify(r).slice(0,200);
      console.error(`[TG] FAILED after 3 attempts: ${detail} | text=${(text||'').slice(0,120)}`);
    }
  }
  return false;
}

// ─── Formatters ────────────────────────────────────────
function fmtPrice(v) {
  if (!v || v <= 0) return '$0';
  if (v < 0.000001) return `$${v.toFixed(10)}`;
  if (v < 0.001) return `$${v.toFixed(8)}`;
  if (v < 1) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(4)}`;
}

function fmtMc(v) {
  if (!v || v <= 0) return '$0';
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function fmtLiq(v) {
  if (!v || v <= 0) return '$0';
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function pctStr(entry, live) {
  if (!entry || !live || entry <= 0) return 'N/A';
  const pct = ((live - entry) / entry * 100).toFixed(1);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

module.exports = {
  gmgn, gmgnAsync, gmgnTokenInfo, gmgnTokenPool, gmgnLastTx, gmgnBatch,
  tgApi, sendTelegram, tgConfig,
  fmtPrice, fmtMc, fmtLiq, pctStr,
};
