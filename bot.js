#!/usr/bin/env node
/**
 * Telegram Bot — handles /list and /help
 * Exported for use by index.js, can also run standalone
 */
const { gmgnTokenInfo, gmgnTokenPool, gmgnLastTx, tgApi, fmtPrice, fmtMc, fmtLiq, pctStr } = require('./lib/shared');
const { routeCommand } = require('./commands/trade');
const { handleCallbackQuery, handlePendingInput, isPendingInput, sendMainMenu } = require('./src/buttons');
const positions = require('./src/positions');
const { getAutoConfig } = require('./src/autotrade');
const fs = require('fs');
const path = require('path');

const SEEN_DIR = path.join(__dirname, 'output');
function getSeenFile() {
  let source = 'trending';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-config.json'), 'utf8'));
    source = cfg.screenerSource || 'trending';
  } catch {}
  return path.join(SEEN_DIR, `gmgn-seen-${source}.json`);
}
const POLL_INTERVAL = 2000;
const MAX_TG_LEN = 3800; // safe limit under 4096
let lastUpdateId = 0;

// Load .env
try {
  const envLines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of envLines) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

// Whitelist: comma-separated chat IDs. Empty = allow all.
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAllowed(chatId) {
  if (!ALLOWED_CHAT_IDS.length) {
    console.warn('[BOT] WARNING: No ALLOWED_CHAT_IDS set — bot accepts messages from ALL chats');
    return true;
  }
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function loadSeen() {
  const merged = {};
  const sources = ['trending', 'trenches', 'signal', 'sm', 'kol'];
  for (const src of sources) {
    try {
      const file = path.join(SEEN_DIR, `gmgn-seen-${src}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Merge — prefer entry with more data (has symbol+score)
      for (const [k, v] of Object.entries(data)) {
        if (!merged[k] || (v.symbol && v.symbol !== '?' && (!merged[k].symbol || merged[k].symbol === '?'))) {
          merged[k] = v;
        }
      }
    } catch {}
  }
  return merged;
}

// Wrapper: per-token timeout (max 6s per token)
async function withTimeout(fn, ms = 6000) {
  return Promise.race([
    fn(),
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

async function fetchTokenData(addr) {
  const [info, pool, lastTx] = await Promise.all([
    withTimeout(() => gmgnTokenInfo(addr)),
    withTimeout(() => gmgnTokenPool(addr)),
    withTimeout(() => gmgnLastTx(addr)),
  ]);
  return { info, pool, lastTx };
}

// Split text into chunks under MAX_TG_LEN, preserving line boundaries
function splitMessage(text) {
  if (text.length <= MAX_TG_LEN) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > MAX_TG_LEN && current) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Send message, auto-split if too long
async function sendMsg(chatId, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const r = await tgApi('sendMessage', {
      chat_id: chatId, text: chunk,
      parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (!r.ok) console.error('[BOT] sendMessage failed:', r.description);
  }
}

async function handleList(chatId) {
  const seen = loadSeen();
  const entries = Object.entries(seen).sort((a, b) => b[1].ts - a[1].ts);

  if (!entries.length) {
    await tgApi('sendMessage', { chat_id: chatId, text: '📭 Belum ada token di screening.', parse_mode: 'HTML' });
    return;
  }

  const limit = Math.min(entries.length, 15);
  console.log(`[BOT] /list: ${entries.length} entries, fetching ${limit}`);

  const lines = [`📋 <b>Screened Tokens</b> — ${entries.length} total\n`];
  let count = 0;

  for (const [addr, d] of entries) {
    if (count >= limit) break;

    console.log(`[BOT] ${count+1}/${limit} fetching ${d.symbol}...`);
    const { info, pool, lastTx } = await fetchTokenData(addr);
    console.log(`[BOT] ${d.symbol}: info=${!!info} pool=${!!pool} tx=${!!lastTx}`);

    const livePrice = info?.price?.price ? parseFloat(info.price.price) : 0;
    const entryPrice = d.price || 0;
    const change = pctStr(entryPrice, livePrice);
    const chg = change.startsWith('+') ? '🟢' : change.startsWith('-') ? '🔴' : '⚪';
    const liq = info?.liquidity ? parseFloat(info.liquidity) : (pool?.liquidity ? parseFloat(pool.liquidity) : 0);
    const holders = info?.holder_count || 0;
    const vol1h = info?.price?.volume_1h ? parseFloat(info.price.volume_1h) : 0;
    const buys1h = info?.price?.buys_1h || 0;
    const sells1h = info?.price?.sells_1h || 0;
    const bs = sells1h > 0 ? (buys1h / sells1h).toFixed(1) : '-';
    const poolAddr = pool?.pool_address || info?.biggest_pool_address || '';
    const exch = pool?.exchange || info?.exchange || '';
    const baseR = pool?.base_reserve_value ? parseFloat(pool.base_reserve_value) : 0;
    const quoteR = pool?.quote_reserve_value ? parseFloat(pool.quote_reserve_value) : 0;
    const ageSince = Math.floor((Date.now() - d.ts) / 60000);
    const ageStr = ageSince >= 60 ? `${(ageSince/60).toFixed(1)}h ago` : `${ageSince}min ago`;
    const circSupply = info?.circulating_supply ? parseFloat(info.circulating_supply) : 0;

    lines.push(
      `<b>${d.symbol || '?'} [P${d.phase || 2}]</b>`,
      `<code>${addr}</code>`, ``,
      `💰 <b>Entry:</b> ${fmtPrice(entryPrice)}`,
      `💰 <b>Now:</b> ${fmtPrice(livePrice)} ${chg} <b>${change}</b>`,
      `📊 <b>MC:</b> ${fmtMc(d.mc || 0)} → ${fmtMc(livePrice * circSupply)}`,
      `💧 <b>LP:</b> ${fmtLiq(liq)} (${fmtLiq(baseR)} / ${fmtLiq(quoteR)})`,
    );
    if (poolAddr) lines.push(`🏊 <b>Pool:</b> <code>${poolAddr}</code>`);
    if (exch) lines.push(`🔄 <b>Exchange:</b> ${exch}`);
    lines.push(
      ``,
      `👥 <b>Holders:</b> ${holders}`,
      `📈 <b>Vol 1h:</b> ${fmtLiq(vol1h)}`,
      `🛒 <b>Buys/Sells:</b> ${buys1h}/${sells1h} (${bs}x)`,
      lastTx ? `⏱ <b>Last Tx:</b> ${lastTx.ageSec < 60 ? lastTx.ageSec + 's' : Math.floor(lastTx.ageSec/60) + 'min'} ago ($${lastTx.vol.toFixed(0)} vol)` : '⏱ <b>Last Tx:</b> N/A',
      `⭐ <b>Score:</b> ${d.score}/100 | ⏳ ${ageStr}`,
    );
    if (d.reasons?.length) lines.push(`• ${d.reasons.join(', ')}`);
    lines.push(``, `🔗 <a href="https://gmgn.ai/sol/token/${addr}">GMGN</a>`, ``);
    count++;
  }

  const fullText = lines.join('\n');
  console.log(`[BOT] /list done: ${count} tokens, ${fullText.length} chars`);
  await sendMsg(chatId, fullText);
}

async function botPoll() {
  const res = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 10, allowed_updates: ['message', 'callback_query'] });
  if (!res.ok) { console.error('[BOT] getUpdates failed:', res.description); return; }
  const updates = res.result || [];
  if (updates.length > 0) console.log(`[BOT] ${updates.length} updates`);
  for (const update of updates) {
    lastUpdateId = update.update_id;

    // Handle inline button callbacks
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!isAllowed(cq.message?.chat?.id)) {
        console.log(`[BOT] Blocked callback from ${cq.message?.chat?.id}`);
        continue;
      }
      try { await handleCallbackQuery(cq); } catch (e) { console.error('[BTN]', e.message); }
      continue;
    }

    const msg = update.message;
    if (!msg?.text) continue;
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) {
      console.log(`[BOT] Blocked unauthorized chat: ${chatId}`);
      continue;
    }
    const rawText = msg.text.trim();
    const text = rawText.toLowerCase();
    
    // Check for pending config input first
    if (isPendingInput(chatId)) {
      try { await handlePendingInput(chatId, rawText); } catch (e) { console.error('[INPUT]', e.message); }
      continue;
    }
    
    const parts = rawText.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    console.log(`[BOT] msg: ${text} from ${msg.from?.username || chatId}`);
    const botUser = process.env.BOT_USERNAME || '';
    const botSuffix = botUser ? `@${botUser}` : '';
    if (text === '/list' || (botSuffix && text === `/list${botSuffix}`)) {
      console.log(`[BOT] /list from ${msg.from?.username || chatId}`);
      await handleList(chatId);
    } else if (text === '/help' || text === '/start' || (botSuffix && text === `/help${botSuffix}`) || text === '/menu') {
      // Show main menu with inline keyboard
      try { await sendMainMenu(chatId); } catch (e) { console.error('[BOT] /menu failed:', e.message); }
    } else {
      // Route to trade commands
      const handled = await routeCommand(chatId, rawText);
      if (!handled) {
        // Unknown command — ignore
      }
    }
  }
}

async function startBot() {
  console.log(`[${new Date().toISOString()}] Bot polling started`);
  while (true) {
    try { await botPoll(); } catch (e) { console.error('[BOT]', e.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

module.exports = { startBot };

// Standalone mode
if (require.main === module) startBot();
