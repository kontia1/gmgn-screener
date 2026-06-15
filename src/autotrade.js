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
      const closed = closePosition(pos.tokenMint, result.outputSol, result.signature, reasonStr);
      setPostCloseLock(pos.tokenMint); // H4 FIX: AFTER successful sell
      releaseSellLock(pos.tokenMint); // C2 FIX

      const isRug = closed.pnlPct <= -80;
      const emoji = closed.pnl >= 0 ? '🟢' : (isRug ? '💀' : '🔴');
      const header = isRug ? `💀 <b>RUG — ${pos.symbol}</b>` : `${emoji} <b>Auto-Sell (${reasonStr}): ${pos.symbol}</b>`;
      await sendTelegram(
        `${header}\n\n` +
        `💰 Got: ${result.outputSol.toFixed(4)} SOL\n` +
        `📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)\n` +
        `📝 Reason: ${reasonStr}\n` +
        `📈 Peak was: +${pos.peakPnlPct ?? '?'}%\n\n` +
        `🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📊 Positions', callback_data: 'menu_positions' },
           { text: '📈 PNL', callback_data: 'menu_pnl' }],
          [{ text: '🏠 Menu', callback_data: 'menu_main' }],
        ]} }
      );
      return { success: true, received: result.outputSol, pnl: closed.pnl, pnlPct: closed.pnlPct };
    }
  } catch (e) {
    releaseSellLock(pos.tokenMint); // C2 FIX: Release on error
    console.error(`[AUTO] Full exit failed: ${e.message}`);
    await sendTelegram(`❌ Auto-Sell failed: ${pos.symbol}\n${e.message}`);
    return { success: false, reason: 'sell_error', error: e.message };
  }
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
    // Fetch current GMGN data via CLI (async, non-blocking)
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);
    const { stdout } = await execAsync(`gmgn-cli token info --chain sol --address ${pos.tokenMint}`, {
      encoding: 'utf8', timeout: 10000,
    });
    const data = JSON.parse(stdout);
    const t = data?.data || {};
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

    // Signal 3: Liquidity drain (drop > 50% from entry)
    // Skip if current liq = 0 AND entry liq < 10000 — likely pre-bond token with no DEX pool (false positive)
    const isPreBond = curLiq === 0 && snap.liquidity < 10000;
    if (snap.liquidity > 1000 && curLiq > 0) {
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

    // isRug if rugScore >= 30 (one strong signal or multiple weak)
    return { isRug: rugScore >= 30, signals, rugScore };

  } catch (e) {
    // Don't block on API errors
    return { isRug: false, signals: [], error: e.message };
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
          const totalReceived = pos.totalSolReceived || 0;
          const pnl = totalReceived - (pos.solSpent || 0);
          closePosition(pos.tokenMint, totalReceived, 'none', 'wallet_empty');
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

      // Rug detection — check GMGN data changes every 30s
      const rugCheckNow = Date.now();
      const lastRugCheck = pos.lastRugCheck || 0;
      if (rugCheckNow - lastRugCheck > 30000 && pos.gmgnSnapshot) {
        try {
          const rugResult = await checkRugSignals(pos);
          if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, { lastRugCheck: rugCheckNow });
          else updatePosition(pos.tokenMint, { lastRugCheck: rugCheckNow });

          if (rugResult.isRug) {
            console.log(`[AUTO] 🚨 ${pos.symbol}: RUG DETECTED — ${rugResult.signals.join(', ')}`);

            // Send alert
            const rugAlertMsg = [
              `🚨 <b>RUG SIGNAL DETECTED</b>`,
              ``,
              `Token: <b>${pos.symbol || 'Unknown'}</b>`,
              `CA: <code>${pos.tokenMint}</code>`,
              `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
              `PNL: ${pnlPct?.toFixed(1) || '?'}%`,
              ``,
              `⚠️ Signals:`,
              ...rugResult.signals.map(s => `• ${s}`),
              ``,
              `Selling immediately...`,
            ].join('\n');
            sendTelegram(rugAlertMsg, { parse_mode: 'HTML' }).catch(() => {});

            if (pos.isDryRun) {
              const virtualSol = quoteSolOut + (pos.totalSolReceived || 0);
              const closed = dryRun.closeDryPosition(pos.tokenMint, virtualSol, 'rug_signal');
              setPostCloseLock(pos.tokenMint);
              await sendTelegram(
                `🟡 <b>DRY RUN — Auto-Sell (Rug Signal): ${pos.symbol}</b>\n\n` +
                `📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)\n` +
                `📝 Reason: ${rugResult.signals.join(', ')}`
              );
            } else {
              try {
                const result = await sellAll(pos.tokenMint, autoConfig.walletLabel, 500);
                if (result.success) {
                  const closed = closePosition(pos.tokenMint, result.outputSol, result.signature, 'rug_signal');
                  setPostCloseLock(pos.tokenMint);
                  const emoji = closed.pnl >= 0 ? '🟢' : '🔴';
                  await sendTelegram(
                    `${emoji} <b>Auto-Sell (Rug Signal): ${pos.symbol}</b>\n\n` +
                    `💰 Got: ${result.outputSol.toFixed(4)} SOL\n` +
                    `📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)\n` +
                    `📝 Reason: ${rugResult.signals.join(', ')}\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a>`
                  );
                }
              } catch (sellErr) {
                console.error(`[AUTO] Rug sell failed: ${sellErr.message}`);
              }
            }
            continue;
          }
        } catch (rugErr) {
          console.error(`[AUTO] Rug check error: ${rugErr.message}`);
        }
      }

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
      const softSlPct = autoConfig.softSlPct || 15;
      const hardSlPct = autoConfig.hardSlPct || autoConfig.slPct || 40;
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
            const closed = dryRun.closeDryPosition(pos.tokenMint, 0, 'bundler_detected');
            setPostCloseLock(pos.tokenMint);
            await sendTelegram(`🟡 <b>DRY RUN — Auto-Sell (Bundler): ${pos.symbol}</b>\n\n📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)`);
          } else {
            try {
              const result = await sellAll(pos.tokenMint, autoConfig.walletLabel, 500);
              if (result.success) {
                const closed = closePosition(pos.tokenMint, result.outputSol, result.signature, 'bundler_detected');
                setPostCloseLock(pos.tokenMint);
                const emoji = closed.pnl >= 0 ? '🟢' : '🔴';
                await sendTelegram(`${emoji} <b>Auto-Sell (Bundler): ${pos.symbol}</b>\n\n💰 Got: ${result.outputSol.toFixed(4)} SOL\n📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)\n🔗 <a href="https://solscan.io/tx/${result.signature}">TX</a>`);
              }
            } catch (sellErr) {
              console.error(`[BUNDLER] Sell failed: ${sellErr.message}`);
              if (sellErr.message.includes('NO_ROUTES') || sellErr.message.includes('No routes')) {
                const closed = closePosition(pos.tokenMint, 0, '', 'bundler_no_routes');
                setPostCloseLock(pos.tokenMint);
                await sendTelegram(`🔴 <b>Auto-Close (Bundler + No Routes): ${pos.symbol}</b>\n\n📊 PNL: -${pos.solSpent?.toFixed(4) || '?'} SOL (total loss)\n📝 Token is dead — position closed`);
              }
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
  console.log(`[AUTO] Monitor started${modeTag} (check every ${autoConfig.checkIntervalSec}s, trailing ${autoConfig.trailingDropPct}% from peak, Soft SL:-${autoConfig.softSlPct}%/${autoConfig.softSlWaitSec}s, Hard SL:-${autoConfig.hardSlPct}%, fast-check: bundler 3s + softSL 3s + liqDrain 10s)`);

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
            const currentPrice = pos.remainingTokens > 0 ? quoteSolOut / pos.remainingTokens : 0;
            const pnlPct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;

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
          const curLiq = parseFloat(curData?.pool?.liquidity || 0);
          const entryLiq = pos.gmgnSnapshot.liquidity;

          if (curLiq <= 0 || entryLiq <= 0) { releaseSellLock(pos.tokenMint); continue; }

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
