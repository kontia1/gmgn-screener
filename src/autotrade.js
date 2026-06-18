/**
 * Auto-Trade Module — auto-buy, trailing TP, partial sell, SL
 * Runs as background loop alongside bot + screener
 */
const { buyToken, sellToken, sellAll, getQuote, SOL_MINT } = require('./trading');
const { openPosition, closePosition, recordPartialSell, getOpenPositions, checkTpSl, calcPnl, updatePosition } = require('./positions');
const { getTokenBalance } = require('./wallet');
const { gmgnTokenInfo, sendTelegram } = require('../lib/shared');
const { autoBuyButtons } = require('./buttons');
const { checkBundlerPattern, saveBundlerDetection, isKnownBundlerToken } = require('./bundler-detector');
const dryRun = require('./dry-run');
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'live',  // 'live' or 'dry_run'
  buyAmountSol: 0.05,
  slippageBps: 500,
  // 2-Layer SL
  softSlPct: 20,              // Layer 1: soft SL threshold (-20%)
  softSlWaitSec: 30,          // Layer 1: wait time before selling (seconds)
  hardSlPct: 25,              // Layer 2: hard SL threshold (-25%), instant sell
  slPct: 25,                  // Legacy fallback (maps to hardSlPct)
  trailingDropPct: 15,       // sell when price drops 15% from peak
  trailingTriggerPct: 30,    // only activate trailing after peak PNL > 30%
  // Liquidity drain detection
  liqDrainEnabled: true,      // enable liquidity drain fast-check
  liqDrainExitPct: 50,        // instant exit when liq drops this % from entry
  liqDrainWarnPct: 30,        // warning alert when liq drops this % from entry
  liqDrainCheckSec: 10,       // check interval per position (seconds)
  liqDrainMinLiq: 1000,       // skip positions with entry liq below this ($)
  minScore: 60,
  maxOpenPositions: 5,
  checkIntervalSec: 15,
  walletLabel: 'default',
};

// Default partial sell levels (configurable via /config partial)
const DEFAULT_PARTIAL_SELLS = [
  { atPct: 50,  sellPct: 25 },   // sell 25% at +50%
  { atPct: 100, sellPct: 25 },   // sell 25% at +100%
  { atPct: 200, sellPct: 25 },   // sell 25% at +200%
  // remaining 25% exits via trailing TP or SL
];

let autoConfig = { ...DEFAULT_CONFIG };
let partialSells = [...DEFAULT_PARTIAL_SELLS];
let monitoring = false;

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'auto-config.json');

// ─── Save Config to Disk ───────────────────────────────
function saveAutoConfig() {
  try {
    const fs = require('fs');
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...autoConfig, partialSells }, null, 2));
  } catch (e) {
    console.error('[AUTO] Save config failed:', e.message);
  }
}

// ─── Load Auto-Trade Config ────────────────────────────
function loadAutoConfig() {
  try {
    const fs = require('fs');
    // 1. Load from .env (legacy)
    const envFile = path.join(__dirname, '..', '.env');
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'AUTO_BUY_ENABLED') autoConfig.enabled = val === 'true';
      if (key === 'AUTO_BUY_AMOUNT_SOL') autoConfig.buyAmountSol = parseFloat(val);
      if (key === 'AUTO_SELL_SL_PCT') autoConfig.slPct = parseFloat(val);
      if (key === 'AUTO_TRAILING_DROP_PCT') autoConfig.trailingDropPct = parseFloat(val);
    }

    // 2. Override from data/auto-config.json (persistent runtime config)
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(autoConfig, saved);
      // Migrate legacy slPct → hardSlPct if hardSlPct not set
      if (!saved.hardSlPct && saved.slPct) {
        autoConfig.hardSlPct = saved.slPct;
      }
      if (saved.partialSells) partialSells = saved.partialSells;
      delete autoConfig.partialSells; // don't keep in autoConfig, stored separately
    }
  } catch (e) { console.error('[AUTO] Config load error:', e.message); }
  // Restore post-close locks from closed positions
  try {
    const closedFile = path.join(__dirname, '..', 'data', 'closed.json');
    const closed = JSON.parse(fs.readFileSync(closedFile, 'utf8'));
    if (Array.isArray(closed)) {
      const now = Date.now();
      for (const c of closed) {
        if (c.tokenMint && c.closedAt) {
          const closedAt = new Date(c.closedAt).getTime();
          const elapsed = now - closedAt;
          if (elapsed < POST_CLOSE_LOCK_MS) {
            buyLocks.set(c.tokenMint, { ts: closedAt, ttlMs: POST_CLOSE_LOCK_MS });
          }
        }
      }
      console.log(`[AUTO] Restored ${buyLocks.size} post-close locks from history`);
    }
  } catch {}
  return autoConfig;
}

// ─── Global Buy Lock ────────────────────────────────────
const buyLocks = new Map();  // CA → { ts, ttlMs }
const POST_CLOSE_LOCK_MS = 24 * 60 * 60 * 1000; // 24 hours

// C2 FIX: Per-mint sell mutex — prevents concurrent sells for same token
const sellLocks = new Map();  // CA → boolean
function acquireSellLock(mint) {
  if (sellLocks.get(mint)) return false;
  sellLocks.set(mint, true);
  return true;
}
function releaseSellLock(mint) {
  sellLocks.delete(mint);
}

function isBuyLocked(mint) {
  const cfg = loadAutoConfig();
  if (cfg.buyLock?.enabled === false) return false;  // explicit false = disabled
  if (!buyLocks.has(mint)) return false;
  const lock = buyLocks.get(mint);
  const elapsed = Date.now() - lock.ts;
  if (elapsed > lock.ttlMs) {
    buyLocks.delete(mint);
    return false;
  }
  return true;
}

function getBuyLockRemaining(mint) {
  if (!buyLocks.has(mint)) return 0;
  const lock = buyLocks.get(mint);
  const remaining = lock.ttlMs - (Date.now() - lock.ts);
  return Math.max(0, Math.ceil(remaining / 1000));
}

function setBuyLock(mint, ttlMs) {
  const cfg = loadAutoConfig();
  const defaultTtl = (cfg.buyLock?.ttlSec || 300) * 1000;
  buyLocks.set(mint, { ts: Date.now(), ttlMs: ttlMs || defaultTtl });
}

// Set 24h lock after position close — prevents re-buying same token
function setPostCloseLock(mint) {
  buyLocks.set(mint, { ts: Date.now(), ttlMs: POST_CLOSE_LOCK_MS });
  console.log(`[AUTO] 🔒 ${mint.slice(0, 8)}... locked for 24h (post-close)`);
}

function getBuyLockStatus() {
  const cfg = loadAutoConfig();
  return {
    enabled: cfg.buyLock?.enabled !== false,
    ttlSec: cfg.buyLock?.ttlSec || 300,
    activeLocks: buyLocks.size,
  };
}

// ─── Auto-Buy on Screener Alert ────────────────────────
async function autoBuy(tokenData) {
  const cfg = loadAutoConfig();
  if (!cfg.enabled) return null;

  const mint = tokenData.address;
  const symbol = tokenData.symbol;

  // Buy lock check — source-agnostic, per CA
  if (isBuyLocked(mint)) {
    const remaining = getBuyLockRemaining(mint);
    console.log(`[AUTO] ${symbol} buy locked (${remaining}s remaining), skip`);
    return { skipped: true, reason: 'buy_lock', remaining };
  }

  // C1 FIX: Set pending buy lock immediately to prevent race condition duplicate buys
  setBuyLock(mint, 30000); // 30s pending lock — prevents concurrent autoBuy for same mint

  // Use correct positions source based on mode (live vs dry-run)
  const isDryMode = cfg.mode === 'dry_run';
  const openPos = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();
  if (openPos.length >= cfg.maxOpenPositions) {
    console.log(`[AUTO] Max positions (${cfg.maxOpenPositions}) reached, skip`);
    return null;
  }

  const score = tokenData._score || 0;

  if (score < cfg.minScore) {
    console.log(`[AUTO] ${symbol} score ${score} < ${cfg.minScore}, skip`);
    return null;
  }

  // Dedup: skip if already have open position for this CA or symbol
  const existingByMint = openPos.find(p => p.tokenMint === mint);
  const existingBySymbol = openPos.find(p => p.symbol?.toLowerCase() === symbol?.toLowerCase());
  if (existingByMint || existingBySymbol) {
    console.log(`[AUTO] ${symbol} already in positions (${existingByMint ? 'same CA' : 'same symbol'}), skip`);
    return null;
  }

  // Pre-buy bundler check — skip if known bundler or active bundler detected
  if (isKnownBundlerToken(mint)) {
    console.log(`[AUTO] 🚨 ${symbol} BLOCKED: known bundler token (history)`);
    return null;
  }
  
  try {
    const mc = tokenData.market_cap || tokenData.fdv || 0;
    const bundlerResult = await checkBundlerPattern(mint, mc, symbol);
    
    // Save detection for learning (even if not bundler)
    saveBundlerDetection(mint, symbol, bundlerResult);
    
    if (bundlerResult.isBundler) {
      console.log(`[AUTO] 🚨 ${symbol} BLOCKED: bundler pattern — ${bundlerResult.details}`);
      return null;
    }
  } catch (e) {
    // Don't block buy if bundler check fails
    console.log(`[AUTO] Bundler check failed for ${symbol}: ${e.message}`);
  }

  console.log(`[AUTO] Buying ${symbol} with ${cfg.buyAmountSol} SOL...`);

  // DRY RUN MODE — virtual buy, no on-chain transaction
  // Uses same Jupiter quote as live mode for accurate pricing
  if (cfg.mode === 'dry_run') {
    // Fetch actual decimals from on-chain (cached, fallback to 6)
    let decimals = 6;
    try {
      const { Connection, PublicKey } = require('@solana/web3.js');
      const { getMint } = require('@solana/spl-token');
      const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
      const mintInfo = await getMint(conn, new PublicKey(mint));
      decimals = mintInfo.decimals;
    } catch { /* fallback to 6 */ }

    // Get Jupiter quote — same as live mode
    const { getQuote, SOL_MINT } = require('./trading');
    const lamports = Math.floor(cfg.buyAmountSol * 1e9);
    let virtualTokenAmount = 0;
    let price = 0;
    try {
      const quote = await getQuote(SOL_MINT, mint, lamports, cfg.slippageBps || 500);
      const rawOutput = parseFloat(quote.outAmount || '0');
      virtualTokenAmount = rawOutput / Math.pow(10, decimals);
      price = virtualTokenAmount > 0 ? cfg.buyAmountSol / virtualTokenAmount : 0;
      console.log(`[AUTO] DRY RUN quote: ${virtualTokenAmount.toFixed(2)} tokens @ ${price.toFixed(10)} SOL/token`);
    } catch (e) {
      console.log(`[AUTO] DRY RUN Jupiter quote failed: ${e.message.slice(0, 60)}, skipping buy`);
      return null;
    }

    if (virtualTokenAmount <= 0) {
      console.log(`[AUTO] DRY RUN: Jupiter returned 0 tokens, skipping`);
      return null;
    }

    const mc = tokenData.market_cap || tokenData.fdv || 0;

    const pos = dryRun.openDryPosition(mint, symbol, price, cfg.buyAmountSol, virtualTokenAmount, decimals, {
      slPct: cfg.hardSlPct || cfg.slPct,
      trailingDropPct: cfg.trailingDropPct,
      trailingTriggerPct: cfg.trailingTriggerPct,
      trailingEnabled: true,
      partialSells: partialSells.map(s => ({ ...s, sold: false, enabled: s.enabled !== false })),
      mc,
      gmgnSnapshot: {
        holders: tokenData.holder_count || 0,
        liquidity: tokenData.liquidity || 0,
        top10: tokenData.top_10_holder_rate || 0,
        creatorHold: 0,
        entrapment: tokenData.entrapment_ratio || 0,
        bundlerRate: tokenData.bundler_rate || 0,
        volume: tokenData.volume_24h || tokenData.volume || 0,
        buys: tokenData.buys_24h || tokenData.buys || 0,
        sells: tokenData.sells_24h || tokenData.sells || 0,
        snapshotAt: Date.now(),
      },
    });

    const activePartials = partialSells.filter(s => s.enabled !== false);
    const partialLines = activePartials.map(s => `• Sell ${s.sellPct}% at +${s.atPct}%`);
    const allocatedPct = activePartials.reduce((sum, s) => sum + s.sellPct, 0);
    const remainingPct = 100 - allocatedPct;
    if (remainingPct > 0) partialLines.push(`• Remaining ${remainingPct}%: trailing TP (drop ${cfg.trailingDropPct}% from peak)`);

    const fmtMc = (v) => !v || v <= 0 ? '$0' : `$${Math.round(v).toLocaleString('en-US')}`;
    await sendTelegram(
      `🟡 <b>DRY RUN — Auto-Buy: ${symbol}</b>\n\n` +
      `💰 Would spend: ${cfg.buyAmountSol} SOL\n` +
      `📦 Would get: ~${virtualTokenAmount.toFixed(2)} tokens\n` +
      `📊 Entry: ${price.toFixed(10)} SOL/token\n` +
      `📈 MC: ${fmtMc(mc)}\n\n` +
      `🎯 <b>Exit Strategy:</b>\n` +
      partialLines.join('\n') + '\n' +
      `• Soft SL: -${cfg.softSlPct}% (wait ${cfg.softSlWaitSec}s)\n` +
      `• Hard SL: -${cfg.hardSlPct}%\n\n` +
      `🔗 <a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
      { reply_markup: autoBuyButtons(mint) }
    );

    return pos;
  }

  try {
    const result = await buyToken(mint, cfg.buyAmountSol, cfg.walletLabel, cfg.slippageBps);

    if (result.success) {
      // Use Jupiter quote outputAmount as primary (RPC may not index new token accounts immediately)
      const decimals = result.decimals || 6;
      const rawOutput = parseFloat(result.outputAmount || '0');
      let tokenAmount = rawOutput / Math.pow(10, decimals);
      let balDecimals = decimals;

      // Try to get actual balance (retry 3 times with delay for RPC indexing)
      if (tokenAmount <= 0) {
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const bal = await getTokenBalance(mint, cfg.walletLabel);
          if (bal.amount > 0) {
            tokenAmount = bal.amount;
            balDecimals = bal.decimals;
            break;
          }
        }
      }

      if (tokenAmount <= 0) {
        await sendTelegram(`⚠️ Auto-Buy succeeded but got 0 tokens. Check TX: https://solscan.io/tx/${result.signature}`);
        return null;
      }

      const entryPrice = cfg.buyAmountSol / tokenAmount;

      const mc = tokenData.market_cap || tokenData.fdv || 0;
      const pos = openPosition(mint, symbol, entryPrice, cfg.buyAmountSol, tokenAmount, balDecimals, result.signature, {
        slPct: cfg.slPct,
        trailingDropPct: cfg.trailingDropPct,
        trailingTriggerPct: cfg.trailingTriggerPct,
        trailingEnabled: true,
        partialSells: partialSells.map(s => ({ ...s, sold: false, enabled: s.enabled !== false })),
        mc,
        gmgnSnapshot: {
          holders: tokenData.holder_count || 0,
          liquidity: tokenData.liquidity || 0,
          top10: tokenData.top_10_holder_rate || 0,
          creatorHold: 0, // not available from trending, will be fetched
          entrapment: tokenData.entrapment_ratio || 0,
          bundlerRate: tokenData.bundler_rate || 0,
          volume: tokenData.volume_24h || tokenData.volume || 0,
          buys: tokenData.buys_24h || tokenData.buys || 0,
          sells: tokenData.sells_24h || tokenData.sells || 0,
          snapshotAt: Date.now(),
        },
      });

      // Build exit strategy from actual config
      const activePartials = partialSells.filter(s => s.enabled !== false);
      const partialLines = activePartials.map(s => `• Sell ${s.sellPct}% at +${s.atPct}%`);
      const allocatedPct = activePartials.reduce((sum, s) => sum + s.sellPct, 0);
      const remainingPct = 100 - allocatedPct;
      if (remainingPct > 0) partialLines.push(`• Remaining ${remainingPct}%: trailing TP (drop ${cfg.trailingDropPct}% from peak)`);

      const fmtMc = (v) => !v || v <= 0 ? '$0' : `$${Math.round(v).toLocaleString('en-US')}`;
      await sendTelegram(
        `🤖 <b>Auto-Buy: ${symbol}</b>\n\n` +
        `💰 Spent: ${cfg.buyAmountSol} SOL\n` +
        `📦 Got: ${tokenAmount.toFixed(2)} tokens\n` +
        `📊 Entry: ${entryPrice.toFixed(10)} SOL/token\n` +
        `📈 MC: ${fmtMc(mc)}\n\n` +
        `🎯 <b>Exit Strategy:</b>\n` +
        partialLines.join('\n') + '\n' +
        `• Soft SL: -${cfg.softSlPct}% (wait ${cfg.softSlWaitSec}s)\n` +
        `• Hard SL: -${cfg.hardSlPct}%\n\n` +
        `🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a> | ` +
        `<a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
        { reply_markup: autoBuyButtons(mint) }
      );

      // Set buy lock after successful buy
      setBuyLock(mint);

      return pos;
    }
  } catch (e) {
    console.error(`[AUTO] Buy failed: ${e.message}`);
    await sendTelegram(`❌ Auto-Buy failed: ${symbol}\n${e.message}`);
  }
  return null;
}

// ─── Execute Partial Sell ──────────────────────────────
async function executePartialSell(pos, partial, currentPrice) {
  const isDry = pos.isDryRun === true;

  // Reload position from disk to get latest remainingTokens
  const positions = require('./positions');
  const freshPos = isDry
    ? (dryRun.getDryPosition(pos.tokenMint) || pos)
    : (positions.getPosition(pos.tokenMint) || pos);
  const tokensToSell = freshPos.remainingTokens * (partial.sellPct / 100);
  if (tokensToSell <= 0) return;

  console.log(`[AUTO] Partial sell ${partial.sellPct}% of ${freshPos.symbol} at +${partial.atPct}% (${tokensToSell.toFixed(2)} tokens)`);

  // DRY RUN — virtual partial sell
  if (isDry) {
    const virtualSol = tokensToSell * currentPrice;
    const newPos = dryRun.recordDryPartialSell(freshPos.tokenMint, tokensToSell, virtualSol, `partial_${partial.atPct}`);

    const curPos = dryRun.getDryPosition(freshPos.tokenMint);
    if (curPos) {
      const updatedPartials = curPos.partialSells.map(s =>
        s.atPct === partial.atPct ? { ...s, sold: true, txSig: 'DRY_RUN' } : s
      );
      dryRun.updateDryPosition(freshPos.tokenMint, { partialSells: updatedPartials });
    }

    const updatedPos = dryRun.getDryPosition(freshPos.tokenMint) || newPos || freshPos;
    const pnl = dryRun.calcDryPnl(updatedPos, currentPrice);
    await sendTelegram(
      `🟡 <b>DRY RUN — Partial Sell: ${freshPos.symbol} (+${partial.atPct}%)</b>\n\n` +
      `📦 Would sell: ${tokensToSell.toFixed(2)} tokens (${partial.sellPct}%)\n` +
      `💰 Would get: ~${virtualSol.toFixed(4)} SOL\n` +
      `📊 Remaining: ${updatedPos.remainingTokens.toFixed(2)} tokens\n` +
      `📈 PNL: ${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL (${pnl.pnlPct}%)`,
      { reply_markup: autoBuyButtons(freshPos.tokenMint) }
    );
    return;
  }

  try {
    const result = await sellToken(freshPos.tokenMint, tokensToSell, freshPos.decimals, autoConfig.walletLabel, 500);

    if (result.success) {
      const newPos = recordPartialSell(freshPos.tokenMint, tokensToSell, result.outputSol, result.signature, `partial_${partial.atPct}`);

      // Mark partial as sold
      const currentPos = positions.getPosition(freshPos.tokenMint);
      if (currentPos) {
        const updatedPartials = currentPos.partialSells.map(s =>
          s.atPct === partial.atPct ? { ...s, sold: true, txSig: result.signature } : s
        );
        positions.updatePosition(freshPos.tokenMint, { partialSells: updatedPartials });
      }

      const updatedPos = positions.getPosition(freshPos.tokenMint) || newPos || freshPos;
      const pnl = calcPnl(updatedPos, currentPrice);
      await sendTelegram(
        `🟢 <b>Partial Sell: ${freshPos.symbol} (+${partial.atPct}%)</b>\n\n` +
        `📦 Sold: ${tokensToSell.toFixed(2)} tokens (${partial.sellPct}%)\n` +
        `💰 Got: ${result.outputSol.toFixed(4)} SOL\n` +
        `📊 Remaining: ${updatedPos.remainingTokens.toFixed(2)} tokens\n` +
        `📈 PNL: ${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL (${pnl.pnlPct}%)\n\n` +
        `🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a>`,
        { reply_markup: autoBuyButtons(freshPos.tokenMint) }
      );
    }
  } catch (e) {
    console.error(`[AUTO] Partial sell failed: ${e.message}`);
  }
}

// ─── Execute Full Exit (trailing/SL) ───────────────────
async function executeFullExit(pos, reason, quoteSolOut = 0, { lockHeld = false } = {}) {
  // Normalize reason to string
  const reasonStr = typeof reason === 'object' ? (reason.type || JSON.stringify(reason)) : String(reason);
  // C2 FIX: Acquire sell lock to prevent concurrent sells
  if (!lockHeld && !acquireSellLock(pos.tokenMint)) {
    console.log(`[AUTO] ${pos.symbol}: sell lock held, skipping exit (${reasonStr})`);
    return { success: false, reason: 'lock_held' };
  }
  console.log(`[AUTO] Full exit ${pos.symbol} (${reasonStr})`);

  // DRY RUN — virtual full exit
  if (pos.isDryRun) {
    const closed = dryRun.closeDryPosition(pos.tokenMint, quoteSolOut, reasonStr);
    setPostCloseLock(pos.tokenMint); // H4 FIX: after close for dry run (no sell to fail)
    releaseSellLock(pos.tokenMint);

    // Exit PNL: profit/loss from this exit relative to original entry
    const remainingCostBasis = pos.solSpent - (pos.totalSolReceived || 0);
    const exitPnl = quoteSolOut - remainingCostBasis;
    const exitPnlPct = pos.solSpent > 0 ? (exitPnl / pos.solSpent * 100) : 0;

    const isRug = closed.pnlPct <= -80;
    const emoji = closed.pnl >= 0 ? '🟢' : (isRug ? '💀' : '🔴');
    const header = isRug ? `🟡 <b>DRY RUN — RUG — ${pos.symbol}</b>` : `${emoji} <b>DRY RUN — Auto-Sell (${reasonStr}): ${pos.symbol}</b>`;

    // Show partial sell info if any
    const partialInfo = (pos.totalSolReceived || 0) > 0
      ? `📦 Partial sold: ${(pos.totalSolReceived || 0).toFixed(4)} SOL\n`
      : '';

    // Reason detail: show peak/drop info for trailing exits
    const reasonDetail = reasonStr.startsWith('trailing') && pos.peakPnlPct != null
      ? ` (${reasonStr}, peak +${pos.peakPnlPct}%, dropped ${autoConfig.trailingDropPct}%)`
      : ` (${reasonStr})`;

    await sendTelegram(
      `${header}\n\n` +
      `📊 <b>Total PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct >= 0 ? '+' : ''}${closed.pnlPct}%)</b>\n` +
      `💰 Would get: ~${quoteSolOut.toFixed(4)} SOL\n` +
      partialInfo +
      `📝 Exit PNL (remaining): ${exitPnl >= 0 ? '+' : ''}${exitPnl.toFixed(4)} SOL (${exitPnlPct >= 0 ? '+' : ''}${exitPnlPct.toFixed(1)}%)\n` +
      `📝 Reason:${reasonDetail}\n` +
      `📈 Peak was: +${pos.peakPnlPct ?? '?'}%`,
      { reply_markup: { inline_keyboard: [
        [{ text: '📊 Positions', callback_data: 'menu_positions' },
         { text: '📈 PNL', callback_data: 'menu_pnl' }],
        [{ text: '🏠 Menu', callback_data: 'menu_main' }],
      ]} }
    );
    return { success: true, received: quoteSolOut, pnl: closed.pnl, pnlPct: closed.pnlPct };
  }

  try {
    const result = await sellAll(pos.tokenMint, autoConfig.walletLabel, 500);

    if (result.success) {
      let closed;
      try {
        closed = closePosition(pos.tokenMint, result.outputSol, result.signature, reasonStr);
      } catch (closeErr) {
        // Race condition: rug-fast/bundler loop may have already closed this position
        if (closeErr.message?.includes('No open position')) {
          console.log(`[AUTO] ${pos.symbol}: position already closed by another loop, skipping`);
          releaseSellLock(pos.tokenMint);
          return { success: true, received: result.outputSol, reason: 'already_closed' };
        }
        throw closeErr; // re-throw unexpected errors
      }
      setPostCloseLock(pos.tokenMint); // H4 FIX: AFTER successful close
      releaseSellLock(pos.tokenMint); // C2 FIX

      // Notification in try-catch so it doesn't break position state
      try {
        const isRug = (closed.pnlPct || 0) <= -80;
        const emoji = (closed.pnl || 0) >= 0 ? '🟢' : (isRug ? '💀' : '🔴');
        const header = isRug ? `💀 <b>RUG — ${pos.symbol}</b>` : `${emoji} <b>Auto-Sell (${reasonStr}): ${pos.symbol}</b>`;
        const totalReceived = closed.solReceived || result.outputSol || 0;
        const hasPartial = (pos.totalSolReceived || 0) > 0;
        await sendTelegram(
          `${header}\n\n` +
          (hasPartial ? `💰 Total: ${totalReceived.toFixed(4)} SOL (exit: ${(result.outputSol || 0).toFixed(4)})\n` : `💰 Got: ${totalReceived.toFixed(4)} SOL\n`) +
          `📊 PNL: ${(closed.pnl || 0) >= 0 ? '+' : ''}${(closed.pnl || 0).toFixed(4)} SOL (${(closed.pnlPct || 0) >= 0 ? '+' : ''}${(closed.pnlPct || 0).toFixed(1)}%)\n` +
          `📝 Reason: ${reasonStr}\n` +
          `📈 Peak was: +${pos.peakPnlPct ?? '?'}%\n\n` +
          `🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a>`,
          { reply_markup: { inline_keyboard: [
            [{ text: '📊 Positions', callback_data: 'menu_positions' },
             { text: '📈 PNL', callback_data: 'menu_pnl' }],
            [{ text: '🏠 Menu', callback_data: 'menu_main' }],
          ]} }
        );
      } catch (notifyErr) {
        console.error(`[AUTO] Notification failed for ${pos.symbol}: ${notifyErr.message}`);
      }
      return { success: true, received: result.outputSol, pnl: closed.pnl, pnlPct: closed.pnlPct };
    }
  } catch (e) {
    releaseSellLock(pos.tokenMint); // C2 FIX: Release on error
    console.error(`[AUTO] Full exit failed: ${e.message}`);
    await sendTelegram(`❌ Auto-Sell failed: ${pos.symbol}\n${e.message}`);
    return { success: false, reason: 'sell_error', error: e.message };
  }
}

// ─── GMGN Direct API Helper (faster than gmgn-cli) ─────
const https = require('https');
const crypto = require('crypto');

function gmgnFetch(chain, address, timeoutMs = 5000) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) return Promise.reject(new Error('GMGN_API_KEY not set'));
  const ts = Math.floor(Date.now() / 1000);
  const cid = crypto.randomUUID();
  const url = `https://openapi.gmgn.ai/v1/token/info?chain=${chain}&address=${address}&timestamp=${ts}&client_id=${cid}`;
  
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'X-APIKEY': apiKey }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 0) reject(new Error(json.message || 'GMGN API error'));
          else resolve(json.data || {});
        } catch (e) { reject(new Error('GMGN JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GMGN API timeout')); });
  });
}

// ─── Rug Signal Detector ─────────────────────────────
// Compares current GMGN data with entry snapshot
// Returns { isRug: bool, signals: string[] }
async function checkRugSignals(pos) {
  const snap = pos.gmgnSnapshot;
  if (!snap) return { isRug: false, signals: [] };

  const signals = [];
  let rugScore = 0;

  try {
    // Direct API call (200ms avg vs 500ms gmgn-cli)
    const t = await gmgnFetch('sol', pos.tokenMint);
    const dev = t.dev || {};
    const stat = t.stat || {};
    const pool = t.pool || {};

    const curHolders = t.holder_count || 0;
    const curTop10 = parseFloat(dev.top_10_holder_rate || 0);
    const curLiq = parseFloat(pool.liquidity || 0);
    const curEntrapment = parseFloat(stat.top_entrapment_trader_percentage || 0);
    const curCreatorHold = parseFloat(stat.creator_hold_rate || 0);
    const curFreshWallet = parseFloat(stat.fresh_wallet_rate || 0);

    // Signal 1: Holder exodus (drop > 40% from entry)
    if (snap.holders > 10 && curHolders > 0) {
      const holderDrop = ((snap.holders - curHolders) / snap.holders) * 100;
      if (holderDrop > 40) {
        signals.push(`Holders dropped ${holderDrop.toFixed(0)}% (${snap.holders} → ${curHolders})`);
        rugScore += 30;
      }
    }

    // Signal 2: Top 10 holder consolidation (spike > 50% from entry)
    if (snap.top10 > 0 && curTop10 > 0) {
      const top10Spike = ((curTop10 - snap.top10) / snap.top10) * 100;
      if (top10Spike > 50) {
        signals.push(`Top10 holders spiked ${top10Spike.toFixed(0)}% (${(snap.top10*100).toFixed(1)}% → ${(curTop10*100).toFixed(1)}%)`);
        rugScore += 30;
      }
    }

    // Signal 3: Liquidity REMOVED (LP = $0) — instant rug
    if (snap.liquidity > 1000 && curLiq === 0) {
      signals.push(`Liquidity REMOVED ($${Math.round(snap.liquidity).toLocaleString()} → $0)`);
      rugScore += 100;
    }
    // Signal 3b: Liquidity drain >50% (partial, still alive)
    else if (snap.liquidity > 1000 && curLiq > 0) {
      const liqDrop = ((snap.liquidity - curLiq) / snap.liquidity) * 100;
      if (liqDrop > 50) {
        signals.push(`Liquidity dropped ${liqDrop.toFixed(0)}% ($${Math.round(snap.liquidity).toLocaleString()} → $${Math.round(curLiq).toLocaleString()})`);
        rugScore += 30;
      }
    }

    // Signal 4: Entrapment spike (was low, now high)
    if (curEntrapment > 0.15 && snap.entrapment < 0.05) {
      signals.push(`Entrapment spiked to ${(curEntrapment*100).toFixed(1)}% (was ${(snap.entrapment*100).toFixed(1)}%)`);
      rugScore += 20;
    }

    // Signal 5: Creator holds > 90% (massive concentration)
    if (curCreatorHold > 0.90) {
      signals.push(`Creator holds ${(curCreatorHold*100).toFixed(1)}% of supply`);
      rugScore += 25;
    }

    // Signal 6: All fresh wallets (> 95%)
    if (curFreshWallet > 0.95) {
      signals.push(`${(curFreshWallet*100).toFixed(0)}% fresh wallets (possible bot/fake wallets)`);
      rugScore += 15;
    }

    // isRug if ANY signal fires (1 signal = instant close, don't wait)
    return { isRug: rugScore > 0, signals, rugScore };

  } catch (e) {
    // API error — retry 2x before giving up (faster retries with direct API)
    console.log(`[RUG] ${pos.symbol}: GMGN API error (${e.message?.slice(0, 60)}), retrying...`);
    for (let attempt = 2; attempt <= 3; attempt++) {
      try {
        await new Promise(r => setTimeout(r, 1000));
        const rt = await gmgnFetch('sol', pos.tokenMint);
        const rStat = rt.stat || {};
        const rPool = rt.pool || {};
        const rDev = rt.dev || {};

        // Quick rug checks on retry data
        const retryHolders = rt.holder_count || 0;
        const retryLiq = parseFloat(rPool.liquidity || 0);
        const retryTop10 = parseFloat(rDev.top_10_holder_rate || 0);
        const retryCreatorHold = parseFloat(rStat.creator_hold_rate || 0);
        const retryEntrapment = parseFloat(rStat.top_entrapment_trader_percentage || 0);

        // If all values are 0/null — token is likely dead/rugged
        if (retryHolders === 0 && retryLiq === 0) {
          signals.push(`GMGN returned 0 holders + $0 liq — token is dead`);
          return { isRug: true, signals, rugScore: 100 };
        }

        // Check absolute rug signals (not relative to snapshot)
        if (retryCreatorHold > 0.90) {
          signals.push(`Creator holds ${(retryCreatorHold*100).toFixed(1)}% of supply (API retry)`);
          rugScore += 25;
        }
        if (retryTop10 > 0.90) {
          signals.push(`Top10 holders own ${(retryTop10*100).toFixed(1)}% (API retry)`);
          rugScore += 30;
        }
        if (retryEntrapment > 0.90) {
          signals.push(`Entrapment ${(retryEntrapment*100).toFixed(1)}% (API retry)`);
          rugScore += 20;
        }

        // Also do relative checks if we got valid data
        if (snap.holders > 10 && retryHolders > 0) {
          const holderDrop = ((snap.holders - retryHolders) / snap.holders) * 100;
          if (holderDrop > 40) {
            signals.push(`Holders dropped ${holderDrop.toFixed(0)}% (${snap.holders} → ${retryHolders})`);
            rugScore += 30;
          }
        }
        if (snap.liquidity > 1000 && retryLiq > 0) {
          const liqDrop = ((snap.liquidity - retryLiq) / snap.liquidity) * 100;
          if (liqDrop > 50) {
            signals.push(`Liquidity dropped ${liqDrop.toFixed(0)}% ($${Math.round(snap.liquidity)} → $${Math.round(retryLiq)})`);
            rugScore += 30;
          }
        }
        if (retryTop10 > 0 && snap.top10 > 0) {
          const top10Spike = ((retryTop10 - snap.top10) / snap.top10) * 100;
          if (top10Spike > 50) {
            signals.push(`Top10 holders spiked ${top10Spike.toFixed(0)}% (${(snap.top10*100).toFixed(1)}% → ${(retryTop10*100).toFixed(1)}%)`);
            rugScore += 30;
          }
        }

        if (signals.length > 0) {
          return { isRug: rugScore > 0, signals, rugScore };
        }
        // Got data but no signals — not a rug
        return { isRug: false, signals: [], rugScore: 0 };
      } catch (retryErr) {
        console.log(`[RUG] ${pos.symbol}: Retry ${attempt}/3 failed: ${retryErr.message?.slice(0, 50)}`);
      }
    }

    // All 3 retries failed — if position is old (> 30 min), treat as suspicious
    const ageMs = Date.now() - new Date(pos.openedAt).getTime();
    if (ageMs > 30 * 60 * 1000) {
      console.log(`[RUG] ${pos.symbol}: All API retries failed after ${Math.round(ageMs/60000)}min old position — treating as suspicious`);
      return { isRug: true, signals: ['GMGN API failed 3x on aged position — possible rug'], rugScore: 50 };
    }
    return { isRug: false, signals: [], error: 'API failed 3x (position too new to flag)' };
  }
}

// ─── Check All Positions ───────────────────────────────
async function checkPositions() {
  const isDryMode = autoConfig.mode === 'dry_run';
  const positions = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();
  if (!positions.length) return;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    // Delay between position checks to avoid rate limiting
    if (i > 0) await new Promise(r => setTimeout(r, 2000));
    try {
      // LIVE MODE ONLY: wallet balance safeguard
      if (!pos.isDryRun) {
        const { getTokenBalance } = require('./wallet');
        const walletBal = await getTokenBalance(pos.tokenMint);
        if (walletBal.amount <= 0) {
          const { closePosition } = require('./positions');
          const pnl = (pos.totalSolReceived || 0) - (pos.solSpent || 0);
          closePosition(pos.tokenMint, 0, 'none', 'wallet_empty');
          setPostCloseLock(pos.tokenMint);
          console.log(`[AUTO] 🧹 ${pos.symbol}: wallet empty, auto-closed (PNL: ${pnl.toFixed(4)} SOL)`);
          sendTelegram(
            `🧹 <b>Auto-Closed: ${pos.symbol}</b>\n\n` +
            `📊 Reason: Wallet balance = 0 (tokens already sold)\n` +
            `💰 PNL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          continue;
        }
      }
      // Use Jupiter quote for accurate PNL (GMGN price is USD and unreliable for new tokens)
      let currentPrice = 0;
      let quoteSolOut = 0;
      let priceSource = 'jupiter';
      try {
        const { getQuote, SOL_MINT } = require('./trading');
        const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
        const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
        quoteSolOut = parseFloat(quote.outAmount) / 1e9;
        currentPrice = pos.remainingTokens > 0 ? quoteSolOut / pos.remainingTokens : 0;
        if (pos.quoteFailCount > 0) {
          if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { quoteFailCount: 0 });
          else { const { updatePosition } = require('./positions'); updatePosition(pos.tokenMint, { quoteFailCount: 0 }); }
        }
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
          // Fallback: try GMGN price when Jupiter has no routes
          try {
            const gmgnData = await gmgnTokenInfo(pos.tokenMint);
            const gmgnPriceUSD = parseFloat(gmgnData?.price?.price || 0);
            if (gmgnPriceUSD > 0) {
              // Get SOL price from GMGN (fetch once per cycle, cached)
              if (!global._solPriceUsd || Date.now() - (global._solPriceTs || 0) > 60000) {
                const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                const d = await resp.json();
                global._solPriceUsd = d.solana.usd;
                global._solPriceTs = Date.now();
              }
              const currentPriceSOL = gmgnPriceUSD / global._solPriceUsd;
              quoteSolOut = currentPriceSOL * pos.remainingTokens;
              currentPrice = currentPriceSOL;
              priceSource = 'gmgn';
              console.log(`[AUTO] ${pos.symbol}: Jupiter NO_ROUTES, using GMGN price ($${gmgnPriceUSD})`);
              if (pos.quoteFailCount > 0) {
                if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { quoteFailCount: 0 });
                else { const { updatePosition } = require('./positions'); updatePosition(pos.tokenMint, { quoteFailCount: 0 }); }
              }
            } else {
              throw new Error('GMGN price unavailable');
            }
          } catch (gmgnErr) {
            // Both Jupiter and GMGN failed — count as NO_ROUTES
            const failCount = (pos.quoteFailCount || 0) + 1;
            if (failCount >= 3) {
                if (pos.isDryRun) {
                  dryRun.closeDryPosition(pos.tokenMint, 0, 'dead_token');
                } else {
                  const { closePosition } = require('./positions');
                  closePosition(pos.tokenMint, 0, 'none', 'dead_token');
                }
                setPostCloseLock(pos.tokenMint);
                console.log(`[AUTO] 💀 ${pos.symbol}: dead token (NO_ROUTES x3), auto-closed`);
                const totalReceived = pos.totalSolReceived || 0;
                const actualLoss = (pos.solSpent || 0) - totalReceived;
                const lossPct = pos.solSpent > 0 ? ((actualLoss / pos.solSpent) * 100) : 100;
                const rugPrefix = pos.isDryRun ? '🟡 <b>DRY RUN —' : '💀 <b>';
                const rugMsg = [
                  `${rugPrefix} RUG DETECTED</b>`,
                  ``,
                  `Token: <b>${pos.symbol || 'Unknown'}</b>`,
                  `CA: <code>${pos.tokenMint}</code>`,
                  `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
                  totalReceived > 0 ? `Recovered: ${totalReceived.toFixed(4)} SOL (partial sells)` : null,
                  `Loss: <b>-${actualLoss.toFixed(4)} SOL (-${lossPct.toFixed(1)}%)</b>`,
                  `Reason: NO_ROUTES_FOUND x3 — token dead`,
                ].filter(Boolean).join('\n');
                sendTelegram(rugMsg, { parse_mode: 'HTML' }).catch(() => {});
                continue;
            }
            if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { quoteFailCount: failCount });
            else { const { updatePosition } = require('./positions'); updatePosition(pos.tokenMint, { quoteFailCount: failCount }); }
            console.log(`[AUTO] ${pos.symbol}: NO_ROUTES (${failCount}/3)`);
            continue;
          }
        } else if (msg.includes('429') || msg.includes('Too many requests')) {
          continue;
        } else {
          console.log(`[AUTO] ${pos.symbol}: Jupiter quote failed, skipping`);
          continue;
        }
      }
      if (!currentPrice) continue;

      // Calculate PNL using SOL-denominated values (must be before bundler + rug detection)
      const currentValueSol = quoteSolOut; // actual SOL we'd get from selling
      const totalValueSol = currentValueSol + (pos.totalSolReceived || 0);
      const pnlSol = totalValueSol - pos.solSpent;
      const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;

      // Bundler check moved to independent 3s loop (checkBundlers)
      // Rug detection moved to independent 3s loop (checkRugs)

      // Rug warning — PNL dropped below -90% (massive dump)
      if (pnlPct <= -90 && !pos.rugWarningSent) {
        const rugPrefix = pos.isDryRun ? '🟡 <b>DRY RUN — RUG WARNING</b>' : '🚨 <b>RUG WARNING</b>';
        const rugWarnMsg = [
          rugPrefix,
          ``,
          `Token: <b>${pos.symbol || 'Unknown'}</b>`,
          `CA: <code>${pos.tokenMint}</code>`,
          `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
          `Now: ${currentValueSol?.toFixed(4) || '0'} SOL`,
          `PNL: <b>${pnlPct.toFixed(1)}% (${pnlSol.toFixed(4)} SOL)</b>`,
          ``,
          `Massive dump detected! SL will trigger soon.`,
        ].join('\n');
        sendTelegram(rugWarnMsg, { parse_mode: 'HTML' }).catch(() => {});
        if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { rugWarningSent: true });
        else updatePosition(pos.tokenMint, { rugWarningSent: true });
        console.log(`[AUTO] 🚨 ${pos.symbol}: RUG WARNING sent (PNL ${pnlPct.toFixed(1)}%)`);
      }
      // Update peak
      if (currentPrice > (pos.peakPrice || 0)) {
        const peakUpdate = { peakPrice: currentPrice, peakPnlPct: parseFloat(pnlPct.toFixed(1)) };
        if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, peakUpdate);
        else updatePosition(pos.tokenMint, peakUpdate);
      }

      const actions = [];

      // 1. Check partial sell levels (skip disabled ones with sellPct=0)
      const pendingPartials = (pos.partialSells || []).filter(s => !s.sold && s.enabled !== false);
      for (const partial of pendingPartials) {
        if (pnlPct >= partial.atPct) {
          actions.push({ type: 'partial', atPct: partial.atPct, sellPct: partial.sellPct });
        }
      }

      // 2. Check trailing TP (only after peak drops by trailingDropPct)
      if (pos.trailingEnabled && pos.peakPrice) {
        const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice * 100);
        const peakPnl = pos.peakPnlPct || 0;
        const triggerPct = autoConfig.trailingTriggerPct || pos.trailingTriggerPct || 20;
        if (peakPnl > triggerPct && dropFromPeak >= (pos.trailingDropPct || 15)) {
          actions.push({ type: 'trailing', dropFromPeak: dropFromPeak.toFixed(1), peakPnl });
        }
      }

      // 3. Check 2-Layer SL
      const softSlPct = autoConfig.softSlPct || 20;
      const hardSlPct = autoConfig.hardSlPct || autoConfig.slPct || 25;
      const softSlWaitSec = autoConfig.softSlWaitSec || 30;

      // Layer 2: Hard SL — instant sell (no mercy)
      if (pnlPct <= -hardSlPct) {
        actions.push({ type: 'hard_sl', pnlPct });
      }
      // Layer 1: Soft SL — wait then sell if no recovery
      else if (pnlPct <= -softSlPct) {
        const now = Date.now();
        if (!pos.softSlTriggeredAt) {
          // First time hitting soft SL — start timer
          if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { softSlTriggeredAt: now });
          else updatePosition(pos.tokenMint, { softSlTriggeredAt: now });
          console.log(`[AUTO] ${pos.symbol}: Soft SL triggered (${pnlPct.toFixed(1)}% <= -${softSlPct}%), waiting ${softSlWaitSec}s for recovery...`);
          sendTelegram(
            `⚠️ <b>Soft SL Warning: ${pos.symbol}</b>\n\n` +
            `📊 PNL: ${pnlPct.toFixed(1)}%\n` +
            `⏳ Waiting ${softSlWaitSec}s for recovery...\n` +
            `🛑 Hard SL: -${hardSlPct}%`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else {
          const elapsed = (now - pos.softSlTriggeredAt) / 1000;
          if (elapsed >= softSlWaitSec) {
            // Timer expired, still below soft SL → sell
            actions.push({ type: 'soft_sl', waited: Math.round(elapsed), pnlPct });
          } else {
            console.log(`[AUTO] ${pos.symbol}: Soft SL waiting... ${Math.round(elapsed)}/${softSlWaitSec}s (PNL ${pnlPct.toFixed(1)}%)`);
          }
        }
      } else {
        // PNL recovered above soft SL — reset timer
        if (pos.softSlTriggeredAt) {
          if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { softSlTriggeredAt: null, rugWarningSent: false });
          else updatePosition(pos.tokenMint, { softSlTriggeredAt: null, rugWarningSent: false });
          console.log(`[AUTO] ${pos.symbol}: Soft SL recovered! (${pnlPct.toFixed(1)}% > -${softSlPct}%)`);
          sendTelegram(
            `✅ <b>Soft SL Recovered: ${pos.symbol}</b>\n\n` +
            `📊 PNL: ${pnlPct.toFixed(1)}% (recovered above -${softSlPct}%)`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }

      console.log(`[AUTO] ${pos.symbol}: PNL ${pnlPct.toFixed(1)}% (${pnlSol.toFixed(4)} SOL), actions: [${actions.map(a=>a.type)}]`);

      for (const action of actions) {
        if (action.type === 'partial') {
          await executePartialSell(pos, action, currentPrice);
          // Reload pos after partial sell to get updated remainingTokens + totalSolReceived
          const freshPos = pos.isDryRun ? dryRun.getOpenDryPositions().find(p => p.tokenMint === pos.tokenMint) : getPosition(pos.tokenMint);
          if (freshPos) Object.assign(pos, freshPos);
        } else if (action.type === 'trailing') {
          await executeFullExit(pos, `trailing (peak +${action.peakPnl}%, dropped ${action.dropFromPeak}%)`, quoteSolOut);
          break; // position closed, skip remaining actions
        } else if (action.type === 'hard_sl') {
          await executeFullExit(pos, `HARD SL (-${hardSlPct}%)`, quoteSolOut);
          break; // position closed
        } else if (action.type === 'soft_sl') {
          await executeFullExit(pos, `Soft SL (waited ${action.waited}s, no recovery)`, quoteSolOut);
          break; // position closed
        }
      }
    } catch (e) {
      console.error(`[AUTO] Check ${pos.symbol} error: ${e.message}`);
    }
  }
}

// ─── Bundler-Only Fast Loop (independent from main monitor) ───
let bundlerRunning = false;
async function checkBundlers() {
  if (bundlerRunning) return;
  bundlerRunning = true;
  try {
    const isDry = autoConfig.mode === 'dry_run';
    const positions = isDry ? dryRun.getOpenDryPositions() : getOpenPositions();
    if (!positions.length) return;

    const now = Date.now();
    for (const pos of positions) {
      const lastCheck = pos.lastBundlerCheck || 0;
      if (now - lastCheck < 3000) continue; // 3s per position

      let lockAcquired = false;
      try {
        const bundlerResult = await checkBundlerPattern(pos.tokenMint, pos.mc || 0, pos.symbol);
        if (isDry) dryRun.updateDryPosition(pos.tokenMint, { lastBundlerCheck: now });
        else updatePosition(pos.tokenMint, { lastBundlerCheck: now });

        saveBundlerDetection(pos.tokenMint, pos.symbol, bundlerResult);

        if (bundlerResult.isBundler) {
          // C2 FIX: Acquire sell lock to prevent concurrent sell from checkPositions
          if (!acquireSellLock(pos.tokenMint)) {
            console.log(`[BUNDLER] ${pos.symbol}: sell lock held, skipping (another sell in progress)`);
            continue;
          }
          lockAcquired = true;
          console.log(`[BUNDLER] 🚨 ${pos.symbol}: ${bundlerResult.details}`);
          const pnlPct = pos.solSpent > 0 ? (((pos.totalSolReceived || 0) - pos.solSpent) / pos.solSpent * 100) : 0;
          const bundlerMsg = [
            `🚨 <b>BUNDLER DETECTED</b>`, ``,
            `Token: <b>${pos.symbol || 'Unknown'}</b>`,
            `CA: <code>${pos.tokenMint}</code>`,
            `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
            ``, `⚠️ Pattern: ${bundlerResult.details}`,
            `Transfers: ${bundlerResult.transfers} | Payers: ${bundlerResult.uniquePayers}`,
            ``, `Selling immediately...`,
          ].join('\n');
          sendTelegram(bundlerMsg, { parse_mode: 'HTML' }).catch(() => {});

          if (isDry) {
            // Get quote for accurate PNL in dry run (retry 3x)
            let bundlerQuoteSol = 0;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const { getQuote: bqGetQuote, SOL_MINT: bqSol } = require('./trading');
                const bqRaw = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
                const bqQuote = await bqGetQuote(pos.tokenMint, bqSol, bqRaw, 500);
                bundlerQuoteSol = parseFloat(bqQuote.outAmount) / 1e9;
                if (bundlerQuoteSol > 0) break;
              } catch (_) {}
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            }
            // Fallback: use GMGN current price if Jupiter failed
            if (bundlerQuoteSol <= 0 && pos.remainingTokens > 0) {
              try {
                const gmgnData = await gmgnTokenInfo(pos.tokenMint);
                const curPrice = parseFloat(gmgnData?.price?.price || 0);
                if (curPrice > 0) {
                  bundlerQuoteSol = pos.remainingTokens * curPrice;
                  console.log(`[BUNDLER] ${pos.symbol}: Jupiter failed, used GMGN price $${curPrice} → ${bundlerQuoteSol.toFixed(4)} SOL`);
                }
              } catch (_) {}
            }
            // Last resort: estimate from entry (should rarely happen)
            if (bundlerQuoteSol <= 0 && pos.entryPrice > 0 && pos.remainingTokens > 0) {
              bundlerQuoteSol = pos.remainingTokens * pos.entryPrice;
              console.log(`[BUNDLER] ${pos.symbol}: All price sources failed, estimated from entry: ${bundlerQuoteSol.toFixed(4)} SOL`);
            }
            const closed = dryRun.closeDryPosition(pos.tokenMint, bundlerQuoteSol, 'bundler_detected');
            setPostCloseLock(pos.tokenMint);
            await sendTelegram(`🟡 <b>DRY RUN — Auto-Sell (Bundler): ${pos.symbol}</b>\n\n📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)`);
          } else {
            // Live: retry sell 3x before giving up
            let sellResult = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                sellResult = await sellAll(pos.tokenMint, autoConfig.walletLabel, 500);
                if (sellResult.success) break;
              } catch (sellErr) {
                console.error(`[BUNDLER] Sell attempt ${attempt}/3 failed: ${sellErr.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
              }
            }
            if (sellResult?.success) {
              const closed = closePosition(pos.tokenMint, sellResult.outputSol, sellResult.signature, 'bundler_detected');
              setPostCloseLock(pos.tokenMint);
              const emoji = closed.pnl >= 0 ? '🟢' : '🔴';
              await sendTelegram(`${emoji} <b>Auto-Sell (Bundler): ${pos.symbol}</b>\n\n💰 Got: ${sellResult.outputSol.toFixed(4)} SOL\n📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)\n🔗 <a href="https://solscan.io/tx/${sellResult.signature}">TX</a>`);
            } else {
              // All 3 retries failed — close as loss
              const closed = closePosition(pos.tokenMint, 0, '', 'bundler_no_routes');
              setPostCloseLock(pos.tokenMint);
              await sendTelegram(`🔴 <b>Auto-Close (Bundler + No Routes): ${pos.symbol}</b>\n\n📊 PNL: -${pos.solSpent?.toFixed(4) || '?'} SOL (total loss)\n📝 Token is dead — position closed`);
            }
          }
          // C2 FIX: Release sell lock after bundler sell attempt
          releaseSellLock(pos.tokenMint);
          lockAcquired = false;
        }
      } catch (e) {
        if (lockAcquired) releaseSellLock(pos.tokenMint);
        console.error(`[BUNDLER] Check ${pos.symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[BUNDLER] Loop error:', e.message);
  } finally {
    bundlerRunning = false;
  }
}

// ─── Start Position Monitor ────────────────────────────
function startMonitor() {
  if (monitoring) return;
  monitoring = true;
  loadAutoConfig();

  const modeTag = autoConfig.mode === 'dry_run' ? ' [DRY RUN]' : ' [LIVE]';
  console.log(`[AUTO] Monitor started${modeTag} (check every ${autoConfig.checkIntervalSec}s, trailing ${autoConfig.trailingDropPct}% from peak, Soft SL:-${autoConfig.softSlPct}%/${autoConfig.softSlWaitSec}s, Hard SL:-${autoConfig.hardSlPct}%, fast-check: bundler 3s + softSL 3s + liqDrain 10s + rug 3s)`);

  // Main monitor loop (PNL, trailing, SL, partial sells)
  async function tick() {
    try { await checkPositions(); }
    catch (e) { console.error('[AUTO] Monitor error:', e.message); }
    setTimeout(tick, autoConfig.checkIntervalSec * 1000);
  }
  setTimeout(tick, autoConfig.checkIntervalSec * 1000);

  // Danger fast-check loop (3s independent — catches hard SL during soft wait + liquidity drain)
  let softSlRunning = false;
  async function softSlTick() {
    if (softSlRunning) return;
    softSlRunning = true;
    try {
      const isDryMode = autoConfig.mode === 'dry_run';
      const allPos = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();

      // ── Part A: Soft SL fast-check (positions in soft SL waiting state) ──
      const softWaiting = allPos.filter(p => p.softSlTriggeredAt);
      if (softWaiting.length > 0) {
        const softSlPct = autoConfig.softSlPct || 20;
        const hardSlPct = autoConfig.hardSlPct || autoConfig.slPct || 25;
        const softSlWaitSec = autoConfig.softSlWaitSec || 30;

        for (const pos of softWaiting) {
          if (!acquireSellLock(pos.tokenMint)) continue;
          try {
            // Get live price via Jupiter quote
            const { getQuote, SOL_MINT } = require('./trading');
            const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
            const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
            const quoteSolOut = parseFloat(quote.outAmount) / 1e9;
            // H1 FIX: Use consistent PNL calc that accounts for partial sells
            const totalValueSol = quoteSolOut + (pos.totalSolReceived || 0);
            const pnlSol = totalValueSol - pos.solSpent;
            const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;

            // Layer 2: Hard SL — instant sell during soft wait
            if (pnlPct <= -hardSlPct) {
              console.log(`[SOFT-SL-FAST] ${pos.symbol}: HARD SL hit during soft wait (${pnlPct.toFixed(1)}% <= -${hardSlPct}%) — instant sell`);
              await executeFullExit(pos, `HARD SL (during soft wait, ${pnlPct.toFixed(1)}%)`, quoteSolOut, { lockHeld: true });
              continue;
            }

            // Layer 1: Soft SL timer expired — sell if still below threshold
            const elapsed = (Date.now() - pos.softSlTriggeredAt) / 1000;
            if (elapsed >= softSlWaitSec && pnlPct <= -softSlPct) {
              console.log(`[SOFT-SL-FAST] ${pos.symbol}: Soft SL timer expired (${elapsed.toFixed(0)}s >= ${softSlWaitSec}s, PNL ${pnlPct.toFixed(1)}%) — selling`);
              await executeFullExit(pos, `Soft SL (fast-check, waited ${Math.round(elapsed)}s)`, quoteSolOut, { lockHeld: true });
              continue;
            }

            // Recovery: PNL recovered above soft SL
            if (pnlPct > -softSlPct) {
              if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, { softSlTriggeredAt: null });
              else { const { updatePosition } = require('./positions'); updatePosition(pos.tokenMint, { softSlTriggeredAt: null }); }
              console.log(`[SOFT-SL-FAST] ${pos.symbol}: recovered (${pnlPct.toFixed(1)}% > -${softSlPct}%) — timer reset`);
            }
          } catch (e) {
            // Jupiter quote failed — skip, main loop will handle NO_ROUTES
            console.log(`[SOFT-SL-FAST] ${pos.symbol}: quote error (${e.message?.slice(0, 50)}), skipping`);
          } finally {
            releaseSellLock(pos.tokenMint);
          }
        }
      }

      // ── Part B: Liquidity drain fast-check (configurable) ──
      if (autoConfig.liqDrainEnabled !== false) {
        const liqCheckNow = Date.now();
        const liqCheckInterval = (autoConfig.liqDrainCheckSec || 10) * 1000;
        const liqExitPct = autoConfig.liqDrainExitPct || 50;
        const liqWarnPct = autoConfig.liqDrainWarnPct || 30;
        const liqMinLiq = autoConfig.liqDrainMinLiq || 1000;

        for (const pos of allPos) {
          const lastLiqCheck = pos._lastLiqCheck || 0;
          if (liqCheckNow - lastLiqCheck < liqCheckInterval) continue;
          if (!pos.gmgnSnapshot?.liquidity || pos.gmgnSnapshot.liquidity < liqMinLiq) continue;

        if (!acquireSellLock(pos.tokenMint)) continue;
        try {
          // Mark check time immediately to avoid re-entry
          if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, { _lastLiqCheck: liqCheckNow });
          else updatePosition(pos.tokenMint, { _lastLiqCheck: liqCheckNow });

          const curData = await gmgnTokenInfo(pos.tokenMint);
          const rawLiq = curData?.pool?.liquidity;
          const curLiq = parseFloat(rawLiq);
          const entryLiq = pos.gmgnSnapshot.liquidity;

          // Skip if API returns null/undefined/NaN/0/tiny (API glitch, not real rug)
          if (!Number.isFinite(curLiq) || curLiq < 100 || entryLiq <= 0) {
            if (curLiq < 100 && curLiq >= 0) console.log(`[LIQ-DRAIN] ${pos.symbol}: GMGN returned liq=$${curLiq}, likely API glitch — skipping`);
            releaseSellLock(pos.tokenMint); continue;
          }

          const liqDrop = ((entryLiq - curLiq) / entryLiq) * 100;

          if (liqDrop >= liqExitPct) {
            console.log(`[LIQ-DRAIN] ${pos.symbol}: liquidity dropped ${liqDrop.toFixed(0)}% ($${Math.round(entryLiq)} → $${Math.round(curLiq)}) — instant exit`);
            // Get quote for accurate PNL in notifications
            let liqQuoteSol = 0;
            try {
              const { getQuote: lqGetQuote, SOL_MINT: lqSol } = require('./trading');
              const lqRaw = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
              const lqQuote = await lqGetQuote(pos.tokenMint, lqSol, lqRaw, 500);
              liqQuoteSol = parseFloat(lqQuote.outAmount) / 1e9;
            } catch (_) {}

            // Fallback 1: use GMGN current price (convert USD → SOL)
            if (liqQuoteSol <= 0 && pos.remainingTokens > 0) {
              try {
                const curPriceUSD = parseFloat(curData?.price?.price || 0);
                if (curPriceUSD > 0) {
                  if (!global._solPriceUsd || Date.now() - (global._solPriceTs || 0) > 60000) {
                    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                    const d = await resp.json();
                    global._solPriceUsd = d.solana.usd;
                    global._solPriceTs = Date.now();
                  }
                  const curPriceSOL = curPriceUSD / global._solPriceUsd;
                  liqQuoteSol = pos.remainingTokens * curPriceSOL;
                  console.log(`[LIQ-DRAIN] ${pos.symbol}: Jupiter failed, used GMGN price ($${curPriceUSD}) → ${liqQuoteSol.toFixed(4)} SOL`);
                }
              } catch (_) {}
            }
            // Fallback 2: estimate from entry price × liq drop ratio
            if (liqQuoteSol <= 0 && pos.entryPrice > 0 && pos.remainingTokens > 0) {
              liqQuoteSol = pos.remainingTokens * pos.entryPrice * ((100 - liqDrop) / 100);
              console.log(`[LIQ-DRAIN] ${pos.symbol}: All sources failed, estimated ${liqQuoteSol.toFixed(4)} SOL from liqDrop`);
            }
            await executeFullExit(pos, `Liq Drain (-${liqDrop.toFixed(0)}%, $${Math.round(entryLiq)}→$${Math.round(curLiq)})`, liqQuoteSol, { lockHeld: true });
          } else if (liqDrop >= liqWarnPct) {
            // Warning at 30% — don't sell yet, but alert
            console.log(`[LIQ-DRAIN] ${pos.symbol}: liquidity warning ${liqDrop.toFixed(0)}% drop ($${Math.round(entryLiq)} → $${Math.round(curLiq)})`);
            if (!pos._liqWarnSent) {
              if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, { _liqWarnSent: true });
              else updatePosition(pos.tokenMint, { _liqWarnSent: true });
              sendTelegram(
                `⚠️ <b>Liquidity Warning: ${pos.symbol}</b>\n\n` +
                `💧 Liq: $${Math.round(entryLiq).toLocaleString()} → $${Math.round(curLiq).toLocaleString()} (-${liqDrop.toFixed(0)}%)\n` +
                `🛑 Auto-exit if drops below ${liqExitPct}%`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          }
          releaseSellLock(pos.tokenMint);
        } catch (e) {
          releaseSellLock(pos.tokenMint);
          console.log(`[LIQ-DRAIN] ${pos.symbol}: GMGN error (${e.message?.slice(0, 50)}), skipping`);
        }
      }
      }
    } catch (e) {
      console.error('[DANGER-FAST] Loop error:', e.message);
    } finally {
      softSlRunning = false;
    }
    setTimeout(softSlTick, 3000);
  }
  setTimeout(softSlTick, 1500); // start after 1.5s (offset from bundler loop)

  // Rug fast-check loop (3s independent — catches LP removal, holder exodus, etc.)
  // Uses direct API (200ms) + parallel checks (all positions at once)
  let rugRunning = false;
  async function rugTick() {
    if (rugRunning) return;
    rugRunning = true;
    try {
      const isDryMode = autoConfig.mode === 'dry_run';
      const allPos = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();
      const now = Date.now();

      // Filter positions that need rug check (throttle 3s per position)
      const toCheck = allPos.filter(p => p.gmgnSnapshot && (now - (p.lastRugCheck || 0)) >= 3000);
      if (toCheck.length === 0) { rugRunning = false; return; }

      // Parallel rug checks (all positions at once — 200ms total vs 2.5s sequential)
      const results = await Promise.allSettled(toCheck.map(async (pos) => {
        const rugResult = await checkRugSignals(pos);
        return { pos, rugResult };
      }));

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { pos, rugResult } = result.value;
        const checkNow = Date.now();

        // Update last check time
        if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, { lastRugCheck: checkNow });
        else updatePosition(pos.tokenMint, { lastRugCheck: checkNow });

        if (rugResult.isRug) {
          console.log(`[RUG-FAST] 🚨 ${pos.symbol}: ${rugResult.signals.join(', ')}`);

          // Get current quote for PNL
          let rugQuoteSol = 0;
          try {
            const { getQuote: rugGetQuote, SOL_MINT: rugSol } = require('./trading');
            const rugRaw = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
            const rugQ = await rugGetQuote(pos.tokenMint, rugSol, rugRaw, 500);
            rugQuoteSol = parseFloat(rugQ.outAmount) / 1e9;
          } catch (_) {}

          // Send alert
          const curPnlPct = pos.solSpent > 0 ? (((rugQuoteSol + (pos.totalSolReceived || 0)) - pos.solSpent) / pos.solSpent * 100) : 0;
          const rugAlertMsg = [
            `🚨 <b>RUG SIGNAL DETECTED</b>`,
            ``,
            `Token: <b>${pos.symbol || 'Unknown'}</b>`,
            `CA: <code>${pos.tokenMint}</code>`,
            `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
            `PNL: ${curPnlPct.toFixed(1)}%`,
            ``,
            `⚠️ Signals:`,
            ...rugResult.signals.map(s => `• ${s}`),
            ``,
            `Selling immediately...`,
          ].join('\n');
          sendTelegram(rugAlertMsg, { parse_mode: 'HTML' }).catch(() => {});

          // Execute sell via executeFullExit
          if (acquireSellLock(pos.tokenMint)) {
            releaseSellLock(pos.tokenMint); // release before executeFullExit which re-acquires
            await executeFullExit(pos, `rug_signal: ${rugResult.signals.join(', ')}`, rugQuoteSol, { lockHeld: false });
          } else {
            console.log(`[RUG-FAST] ${pos.symbol}: sell lock held, will retry next cycle`);
          }
        }
      }
    } catch (e) {
      console.error('[RUG-FAST] Loop error:', e.message);
    } finally {
      rugRunning = false;
    }
    setTimeout(rugTick, 3000);
  }
  setTimeout(rugTick, 2000); // start after 2s (offset from other loops)

  // Bundler fast loop (3s independent — catches bursts before dump)
  async function bundlerTick() {
    try { await checkBundlers(); }
    catch (e) { console.error('[BUNDLER] Tick error:', e.message); }
    setTimeout(bundlerTick, 3000);
  }
  setTimeout(bundlerTick, 1000); // start after 1s
}

// ─── Update Config (runtime + persist) ─────────────────
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function updateAutoConfig(updates) {
  deepMerge(autoConfig, updates);
  saveAutoConfig();
  console.log('[AUTO] Config updated:', updates);
  return autoConfig;
}

function getAutoConfig() {
  return { ...autoConfig, partialSells: [...partialSells] };
}

// ─── Partial Sells Management ──────────────────────────
function setPartialSells(levels) {
  partialSells = levels.sort((a, b) => a.atPct - b.atPct);
  saveAutoConfig();
  return partialSells;
}

function addPartialSell(atPct, sellPct) {
  // Remove existing level at same atPct
  partialSells = partialSells.filter(s => s.atPct !== atPct);
  partialSells.push({ atPct, sellPct });
  partialSells.sort((a, b) => a.atPct - b.atPct);
  saveAutoConfig();
  return partialSells;
}

function removePartialSell(atPct) {
  partialSells = partialSells.filter(s => s.atPct !== atPct);
  saveAutoConfig();
  return partialSells;
}

function editPartialSell(index, atPct, sellPct) {
  if (index < 0 || index >= partialSells.length) return null;
  partialSells[index] = { atPct, sellPct, enabled: true };
  partialSells.sort((a, b) => a.atPct - b.atPct);
  saveAutoConfig();
  return partialSells;
}

function disablePartialSell(index) {
  if (index < 0 || index >= partialSells.length) return null;
  partialSells[index] = { ...partialSells[index], enabled: false };
  saveAutoConfig();
  return partialSells;
}

function enablePartialSell(index) {
  if (index < 0 || index >= partialSells.length) return null;
  partialSells[index] = { ...partialSells[index], enabled: true };
  saveAutoConfig();
  return partialSells;
}

function resetPartialSells() {
  partialSells = [...DEFAULT_PARTIAL_SELLS];
  saveAutoConfig();
  return partialSells;
}

module.exports = {
  autoBuy, checkPositions, startMonitor,
  updateAutoConfig, getAutoConfig, loadAutoConfig,
  getOpenPositions,
  setPartialSells, addPartialSell, removePartialSell, resetPartialSells,
  editPartialSell, disablePartialSell, enablePartialSell,
  isBuyLocked, getBuyLockRemaining, setBuyLock, getBuyLockStatus, setPostCloseLock,
  acquireSellLock, releaseSellLock,
};
