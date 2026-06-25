/**
 * Auto-Trade Module — auto-buy, trailing TP, partial sell, SL
 * Runs as background loop alongside bot + screener
 */
const { buyToken, sellToken, sellAll, getQuote, SOL_MINT } = require('./trading');
const { openPosition, closePosition, recordPartialSell, getOpenPositions, getPosition, checkTpSl, calcPnl, updatePosition } = require('./positions');
const { getTokenBalance } = require('./wallet');
const { gmgnTokenInfo, sendTelegram } = require('../lib/shared');
const { autoBuyButtons } = require('./buttons');
const { checkBundlerPattern, saveBundlerDetection, isKnownBundlerToken } = require('./bundler-detector');
const dryRun = require('./dry-run');
const fs = require('fs');
const path = require('path');

// ─── Shared API Cache ──────────────────────────────────────
const gmgnCache = new Map(); // mint → { data, ts }
const GMGN_CACHE_TTL = 2000; // 2s

function getCachedGmgn(mint) {
  const entry = gmgnCache.get(mint);
  if (entry && Date.now() - entry.ts < GMGN_CACHE_TTL) return entry.data;
  return null;
}
function setCachedGmgn(mint, data) {
  gmgnCache.set(mint, { data, ts: Date.now() });
}
async function gmgnFetchCached(chain, address, timeoutMs = 5000) {
  const cached = getCachedGmgn(address);
  if (cached) return cached;
  const data = await gmgnFetch(chain, address, timeoutMs);
  setCachedGmgn(address, data);
  return data;
}

// Jupiter quote cache
const jupiterCache = new Map(); // key(mint+amount) → { quote, ts }
const JUPITER_CACHE_TTL = 3000; // 3s
function getCachedJupiter(mint, amount) {
  const key = `${mint}_${amount}`;
  const entry = jupiterCache.get(key);
  if (entry && Date.now() - entry.ts < JUPITER_CACHE_TTL) return entry.quote;
  return null;
}
function setCachedJupiter(mint, amount, quote) {
  const key = `${mint}_${amount}`;
  jupiterCache.set(key, { quote, ts: Date.now() });
}

// Global Jupiter rate limiter
let jupiterCallsThisTick = 0;
const MAX_JUPITER_PER_TICK = 4;

// SOL price cache (for GMGN USD→SOL conversion)
async function getSolPriceUsd() {
  if (!global._solPriceUsd || Date.now() - (global._solPriceTs || 0) > 60000) {
    try {
      const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const d = await resp.json();
      global._solPriceUsd = d.solana.usd;
      global._solPriceTs = Date.now();
    } catch (_) {}
  }
  return global._solPriceUsd || 0;
}

// Position field update helper
function updatePosField(pos, isDryMode, data) {
  if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, data);
  else updatePosition(pos.tokenMint, data);
}

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

    const _entrapment = tokenData.entrapment_ratio || 0;
    const _bundlerRate = tokenData.bundler_rate || 0;
    const _liq = tokenData.liquidity || 0;
    const entryRiskScore = (
      (_entrapment < 0.05 ? 40 : 0) +
      (_bundlerRate > 0.15 ? 30 : _bundlerRate > 0.10 ? 20 : 0) +
      (_liq < 30000 ? 20 : _liq < 60000 ? 10 : 0)
    );
    const mc = tokenData.market_cap || tokenData.fdv || 0;

    const pos = dryRun.openDryPosition(mint, symbol, price, cfg.buyAmountSol, virtualTokenAmount, decimals, {
      slPct: cfg.hardSlPct || cfg.slPct,
      hardSlPct: entryRiskScore >= 60 ? Math.min(cfg.hardSlPct || 25, 15) : undefined,
      trailingDropPct: cfg.trailingDropPct,
      trailingTriggerPct: cfg.trailingTriggerPct,
      trailingEnabled: true,
      partialSells: partialSells.map(s => ({ ...s, sold: false, enabled: s.enabled !== false })),
      mc,
      gmgnSnapshot: {
        holders: tokenData.holder_count || 0,
        liquidity: tokenData.liquidity || 0,
        top10: tokenData.top_10_holder_rate || 0,
        creatorHold: parseFloat(tokenData?.creator_hold_rate || 0),
        entrapment: tokenData.entrapment_ratio || 0,
        bundlerRate: tokenData.bundler_rate || 0,
        volume: tokenData.volume_24h || tokenData.volume || 0,
        buys: tokenData.buys_24h || tokenData.buys || 0,
        sells: tokenData.sells_24h || tokenData.sells || 0,
        buyRatio: (tokenData.buys_24h || tokenData.buys || 0) > 0 && (tokenData.sells_24h || tokenData.sells || 0) > 0
          ? ((tokenData.buys_24h || tokenData.buys || 0) / (tokenData.sells_24h || tokenData.sells || 1))
          : 0,
        priceChange5m: tokenData.price_change_percent5m || 0,
        priceChange1h: tokenData.price_change_percent1h || 0,
        fdv: tokenData.fdv || 0,
        website: tokenData.website || '',
        twitter: tokenData.twitter_username || '',
        telegram: tokenData.telegram || '',
        entryRiskScore,
        snapshotAt: Date.now(),
        source: tokenData._source || 'unknown',
        ageMin: tokenData._ageMin || 0,
        // ── New: full GMGN data ──
        sniper: tokenData.sniper_count || 0,
        botDegenRate: tokenData.bot_degen_rate || 0,
        smartDegen: tokenData.smart_degen_count || 0,
        freshWalletRate: tokenData._dev?.fresh_wallet_rate ?? tokenData.fresh_wallet_rate ?? 0,
        creatorOpenCount: tokenData._dev?.creator_open_count ?? tokenData.creator_open_count ?? 0,
        twitterCreateTokenCount: tokenData._dev?.twitter_create_token_count ?? tokenData.twitter_create_token_count ?? 0,
        twitterDelPostCount: tokenData._dev?.twitter_del_post_token_count ?? tokenData.twitter_del_post_token_count ?? 0,
        dexscrBoostFee: tokenData._dev?.dexscr_boost_fee ?? tokenData.dexscr_boost_fee ?? 0,
        ctoFlag: tokenData._dev?.cto_flag ?? tokenData.cto_flag ?? 0,
        imageDupCount: tokenData._dev?.image_dup_count ?? tokenData.image_dup_count ?? 0,
        initialLiquidity: tokenData._pool?.initial_liquidity ? parseFloat(tokenData._pool.initial_liquidity) : (tokenData.initial_liquidity || 0),
        exchange: tokenData._pool?.exchange || tokenData.exchange || '',
        sniperWallets: tokenData._walletTags?.sniper_wallets ?? 0,
        bundlerWallets: tokenData._walletTags?.bundler_wallets ?? 0,
        smartWallets: tokenData._walletTags?.smart_wallets ?? 0,
        ratTraderWallets: tokenData._walletTags?.rat_trader_wallets ?? 0,
        freshWallets: tokenData._walletTags?.fresh_wallets ?? 0,
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
    // Pre-buy GMGN liquidity recheck — fetch current pool data before submitting swap TX
    // If liquidity dropped > 50% from screener scan time, skip the buy
    const screenerLiq = tokenData.liquidity || 0;
    if (screenerLiq > 0) {
      try {
        const curInfo = await gmgnTokenInfo(mint);
        const curLiq = parseFloat(curInfo?.pool?.liquidity || '0');
        if (curLiq > 0 && curLiq < screenerLiq * 0.5) {
          console.log(`[AUTO] ${symbol} SKIP: liquidity dropped ${((1 - curLiq / screenerLiq) * 100).toFixed(0)}% (screener: $${screenerLiq.toFixed(0)} → now: $${curLiq.toFixed(0)})`);
          buyLocks.delete(mint);
          return null;
        }
        console.log(`[AUTO] Pre-buy liquidity check OK: $${curLiq.toFixed(0)} (screener: $${screenerLiq.toFixed(0)})`);
      } catch (liqErr) {
        // Don't block buy if liquidity recheck fails — just log and proceed
        console.log(`[AUTO] Pre-buy liquidity recheck failed: ${liqErr.message}, proceeding with buy`);
      }
    }

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

      const _entrapment = tokenData.entrapment_ratio || 0;
      const _bundlerRate = tokenData.bundler_rate || 0;
      const _liq = tokenData.liquidity || 0;
      const entryRiskScore = (
        (_entrapment < 0.05 ? 40 : 0) +
        (_bundlerRate > 0.15 ? 30 : _bundlerRate > 0.10 ? 20 : 0) +
        (_liq < 30000 ? 20 : _liq < 60000 ? 10 : 0)
      );
      const mc = tokenData.market_cap || tokenData.fdv || 0;
      const pos = openPosition(mint, symbol, entryPrice, cfg.buyAmountSol, tokenAmount, balDecimals, result.signature, {
        slPct: cfg.slPct,
        hardSlPct: entryRiskScore >= 60 ? Math.min(cfg.hardSlPct || 25, 15) : undefined,
        trailingDropPct: cfg.trailingDropPct,
        trailingTriggerPct: cfg.trailingTriggerPct,
        trailingEnabled: true,
        partialSells: partialSells.map(s => ({ ...s, sold: false, enabled: s.enabled !== false })),
        mc,
        gmgnSnapshot: {
          holders: tokenData.holder_count || 0,
          liquidity: tokenData.liquidity || 0,
          top10: tokenData.top_10_holder_rate || 0,
          creatorHold: parseFloat(tokenData?.creator_hold_rate || 0),
          entrapment: tokenData.entrapment_ratio || 0,
          bundlerRate: tokenData.bundler_rate || 0,
          volume: tokenData.volume_24h || tokenData.volume || 0,
          buys: tokenData.buys_24h || tokenData.buys || 0,
          sells: tokenData.sells_24h || tokenData.sells || 0,
          buyRatio: (tokenData.buys_24h || tokenData.buys || 0) > 0 && (tokenData.sells_24h || tokenData.sells || 0) > 0
            ? ((tokenData.buys_24h || tokenData.buys || 0) / (tokenData.sells_24h || tokenData.sells || 1))
            : 0,
          priceChange5m: tokenData.price_change_percent5m || 0,
          priceChange1h: tokenData.price_change_percent1h || 0,
          fdv: tokenData.fdv || 0,
          website: tokenData.website || '',
          twitter: tokenData.twitter_username || '',
          telegram: tokenData.telegram || '',
          entryRiskScore,
          snapshotAt: Date.now(),
          source: tokenData._source || 'unknown',
          ageMin: tokenData._ageMin || 0,
          // ── New: full GMGN data ──
          sniper: tokenData.sniper_count || 0,
          botDegenRate: tokenData.bot_degen_rate || 0,
          smartDegen: tokenData.smart_degen_count || 0,
          freshWalletRate: tokenData._dev?.fresh_wallet_rate ?? tokenData.fresh_wallet_rate ?? 0,
          creatorOpenCount: tokenData._dev?.creator_open_count ?? tokenData.creator_open_count ?? 0,
          twitterCreateTokenCount: tokenData._dev?.twitter_create_token_count ?? tokenData.twitter_create_token_count ?? 0,
          twitterDelPostCount: tokenData._dev?.twitter_del_post_token_count ?? tokenData.twitter_del_post_token_count ?? 0,
          dexscrBoostFee: tokenData._dev?.dexscr_boost_fee ?? tokenData.dexscr_boost_fee ?? 0,
          ctoFlag: tokenData._dev?.cto_flag ?? tokenData.cto_flag ?? 0,
          imageDupCount: tokenData._dev?.image_dup_count ?? tokenData.image_dup_count ?? 0,
          initialLiquidity: tokenData._pool?.initial_liquidity ? parseFloat(tokenData._pool.initial_liquidity) : (tokenData.initial_liquidity || 0),
          exchange: tokenData._pool?.exchange || tokenData.exchange || '',
          sniperWallets: tokenData._walletTags?.sniper_wallets ?? 0,
          bundlerWallets: tokenData._walletTags?.bundler_wallets ?? 0,
          smartWallets: tokenData._walletTags?.smart_wallets ?? 0,
          ratTraderWallets: tokenData._walletTags?.rat_trader_wallets ?? 0,
          freshWallets: tokenData._walletTags?.fresh_wallets ?? 0,
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
    // Release the 30s pending buy lock immediately on failure so it doesn't block future attempts
    buyLocks.delete(mint);
    await sendTelegram(`❌ Auto-Buy failed: ${symbol}\n${e.message}`);
  }
  return null;
}

// ─── Execute Partial Sell ──────────────────────────────
async function executePartialSell(pos, partial, currentPrice) {
  const isDry = pos.isDryRun === true;

  // Acquire sell lock to prevent concurrent sells (dual partial sell bug fix)
  const lockFromCaller = partial._lockHeld === true;
  if (!isDry && !lockFromCaller && !acquireSellLock(pos.tokenMint)) {
    console.log(`[AUTO] ${pos.symbol}: sell lock held, skipping partial sell`);
    return { success: false, reason: 'sell_lock_held' };
  }

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

    // TRAILING TP FIX: Keep peakPrice at ATH (don't reset to current price)
    // Only update peakPnlPct to remaining-only PNL for display
    const dryRemainingPnlPct = ((currentPrice / freshPos.entryPrice) - 1) * 100;
    dryRun.updateDryPosition(freshPos.tokenMint, {
      peakPnlPct: parseFloat(dryRemainingPnlPct.toFixed(1)),
      _partialSellReset: true,
    });
    console.log(`[AUTO] ${freshPos.symbol}: Dry partial sell complete (remaining-only PNL: ${dryRemainingPnlPct.toFixed(1)}%, peakPrice kept at ATH)`);

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

      // TRAILING TP FIX: Keep peakPrice at ATH (don't reset to current price)
      // Only update peakPnlPct to remaining-only PNL for display
      const liveRemainingPnlPct = ((currentPrice / freshPos.entryPrice) - 1) * 100;
      positions.updatePosition(freshPos.tokenMint, {
        peakPnlPct: parseFloat(liveRemainingPnlPct.toFixed(1)),
        _partialSellReset: true,
      });
      console.log(`[AUTO] ${freshPos.symbol}: Partial sell complete (remaining-only PNL: ${liveRemainingPnlPct.toFixed(1)}%, peakPrice kept at ATH)`);

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
    if (e.message?.includes("NO_ROUTES") || e.message?.includes("No routes")) {
      console.log(`[AUTO] ${freshPos.symbol}: partial sell NO_ROUTES, marking as failed`);
    }
  } finally {
    // Release sell lock if we acquired it (not from caller)
    if (!isDry && !lockFromCaller) releaseSellLock(pos.tokenMint);
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
        // Defensive PNL recalculation — closed.pnl can be NaN if pos.totalSolReceived was undefined on disk
        const exitSol = result.outputSol || 0;
        const partialSol = closed.totalSolReceived || pos.totalSolReceived || 0;
        const totalRecv = (closed.solReceived && !isNaN(closed.solReceived)) ? closed.solReceived : (partialSol + exitSol);
        const spent = closed.solSpent || pos.solSpent || 0;
        const safePnl = (closed.pnl !== undefined && !isNaN(closed.pnl)) ? closed.pnl : (totalRecv - spent);
        const safePnlPct = (closed.pnlPct !== undefined && !isNaN(closed.pnlPct)) ? closed.pnlPct : (spent > 0 ? (safePnl / spent * 100) : 0);
        const hasPartial = partialSol > 0;

        const isRug = safePnlPct <= -80;
        const emoji = safePnl >= 0 ? '🟢' : (isRug ? '💀' : '🔴');
        const header = isRug ? `💀 <b>RUG — ${pos.symbol}</b>` : `${emoji} <b>Auto-Sell (${reasonStr}): ${pos.symbol}</b>`;
        await sendTelegram(
          `${header}\n\n` +
          (hasPartial ? `💰 Total: ${totalRecv.toFixed(4)} SOL (exit: ${exitSol.toFixed(4)})\n` : `💰 Got: ${totalRecv.toFixed(4)} SOL\n`) +
          `📊 PNL: ${safePnl >= 0 ? '+' : ''}${safePnl.toFixed(4)} SOL (${safePnlPct >= 0 ? '+' : ''}${safePnlPct.toFixed(1)}%)\n` +
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
    } else {
      console.log(`[AUTO] ${pos.symbol}: sellAll returned success=false`);
      releaseSellLock(pos.tokenMint);
      return { success: false, reason: 'sell_failed' };
    }
  } catch (e) {
    releaseSellLock(pos.tokenMint); // C2 FIX: Release on error
    const msg = e.message || '';
    if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
      // Token is unsellable — close as dead token (0 SOL received) to stop retry spam
      console.log(`[AUTO] 💀 ${pos.symbol}: NO_ROUTES during sell, closing as dead token`);
      try {
        closePosition(pos.tokenMint, 0, 'none', 'dead_token_no_routes');
      } catch (closeErr) {
        if (!closeErr.message?.includes('No open position')) throw closeErr;
      }
      setPostCloseLock(pos.tokenMint);
      const totalReceived = pos.totalSolReceived || 0;
      const actualLoss = (pos.solSpent || 0) - totalReceived;
      const lossPct = pos.solSpent > 0 ? (actualLoss / pos.solSpent * 100) : 100;
      const rugMsg = [
        `💀 <b>RUG — ${pos.symbol}</b>`,
        ``,
        `Token: <b>${pos.symbol || 'Unknown'}</b>`,
        `CA: <code>${pos.tokenMint}</code>`,
        `Entry: ${pos.solSpent?.toFixed(4) || '?'} SOL`,
        totalReceived > 0 ? `Recovered: ${totalReceived.toFixed(4)} SOL (partial sells)` : null,
        `Loss: <b>-${actualLoss.toFixed(4)} SOL (-${lossPct.toFixed(1)}%)</b>`,
        `Reason: NO_ROUTES_FOUND — token dead (triggered by: ${reasonStr})`,
      ].filter(Boolean).join('\n');
      sendTelegram(rugMsg, { parse_mode: 'HTML' }).catch(() => {});
      return { success: false, reason: 'dead_token' };
    }
    const failCount = (pos.sellFailCount || 0) + 1;
    if (!pos.isDryRun) { try { const { updatePosition: uf } = require("./positions"); uf(pos.tokenMint, { sellFailCount: failCount }); } catch(_) {} }
    if (failCount >= 3) {
      console.error(`[AUTO] ${pos.symbol}: sell failed ${failCount}x, closing as loss`);
      try { closePosition(pos.tokenMint, 0, "", "sell_failed_3x"); } catch(_) {}
      setPostCloseLock(pos.tokenMint);
      sendTelegram(`🔴 <b>Auto-Close (Sell Failed 3x): ${pos.symbol}</b>\n\n📊 PNL: -${(pos.solSpent || 0).toFixed(4)} SOL (total loss)\n📝 Error: ${e.message}`).catch(() => {});
    } else {
      console.error(`[AUTO] Full exit failed (${failCount}/3): ${e.message}`);
      await sendTelegram(`❌ Auto-Sell failed: ${pos.symbol}\n${e.message}\n⚠️ Attempt ${failCount}/3`);
    }
    return { success: false, reason: 'sell_error', error: e.message, failCount };
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
async function checkRugSignals(pos, cachedGmgnData, cachedLastQuoteSol) {
  const snap = pos.gmgnSnapshot;
  if (!snap) return { isRug: false, signals: [] };

  const signals = [];
  let rugScore = 0;

  // FIX 2: Time-since-buy dampener — structural signals less reliable right after buy
  const timeSinceBuySec = (Date.now() - (snap.snapshotAt || 0)) / 1000;
  const timeDampener = timeSinceBuySec < 30 ? 0.2
    : timeSinceBuySec < 60 ? 0.4
    : timeSinceBuySec < 120 ? 0.7
    : timeSinceBuySec < 300 ? 0.9
    : 1.0;

  // Jupiter price check — fast price-drop detection before GMGN API call
  try {
    const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals || 6));
    if (rawAmount > 0 && pos.remainingTokens > 0) {
      let quoteSolOut = pos._lastRugQuoteSol || cachedLastQuoteSol || 0; // reuse cached
      if (!quoteSolOut) {
        const priceQuote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
        quoteSolOut = parseFloat(priceQuote.outAmount) / 1e9;
      }
      pos._lastRugQuoteSol = quoteSolOut;
      const entryPriceSol = (pos.tokenAmount > 0) ? pos.solSpent / pos.tokenAmount : pos.entryPrice;
      const currentPriceSol = quoteSolOut / pos.remainingTokens;
      const priceDrop = entryPriceSol > 0 ? ((entryPriceSol - currentPriceSol) / entryPriceSol * 100) : 0;
      if (priceDrop > 40) {
        signals.push(`Price dropped ${priceDrop.toFixed(0)}% from entry (Jupiter)`);
        rugScore += 50;
      } else if (priceDrop > 20) {
        signals.push(`Price down ${priceDrop.toFixed(0)}% from entry — early warning`);
        rugScore += 25;
      }
    }
  } catch (_) {
    // NO_ROUTES handled in rugTick pre-check; other errors skip Jupiter price signal
  }

  try {
    // Use cached GMGN data if available, else fetch
    const t = cachedGmgnData || await gmgnFetch('sol', pos.tokenMint);
    const dev = t.dev || {};
    const stat = t.stat || {};
    const pool = t.pool || {};

    const curHolders = t.holder_count || 0;
    const curTop10 = parseFloat(dev.top_10_holder_rate || 0);
    const curLiq = parseFloat(pool.liquidity || 0);
    const curEntrapment = parseFloat(stat.top_entrapment_trader_percentage || 0);
    const curCreatorHold = parseFloat(stat.creator_hold_rate || 0);
    const curFreshWallet = parseFloat(stat.fresh_wallet_rate || 0);
    const curSellVol5m = parseFloat(stat.sell_volume_5m || 0);
    const curBuyVol5m = parseFloat(stat.buy_volume_5m || 0);
    const curSells5m = parseInt(stat.sells_5m || 0);
    const curBuys5m = parseInt(stat.buys_5m || 0);

    // Signal 1: Holder exodus — EARLY at 15% (+15), EXIT at 25% (+30)
    if (snap.holders > 10 && curHolders > 0) {
      const holderDrop = ((snap.holders - curHolders) / snap.holders) * 100;
      if (holderDrop > 25) {
        signals.push(`Holders dropped ${holderDrop.toFixed(0)}% (${snap.holders} → ${curHolders})`);
        rugScore += 30;
      } else if (holderDrop > 15) {
        signals.push(`Holders dropping ${holderDrop.toFixed(0)}% — early warning (${snap.holders} → ${curHolders})`);
        rugScore += 15;
      }
    }

    // Signal 2: Top 10 holder consolidation — EARLY at 20% (+15), EXIT at 30% (+30)
    if (snap.top10 > 0 && curTop10 > 0) {
      const top10Spike = ((curTop10 - snap.top10) / snap.top10) * 100;
      if (top10Spike > 30) {
        signals.push(`Top10 spiked ${top10Spike.toFixed(0)}% (${(snap.top10*100).toFixed(1)}% → ${(curTop10*100).toFixed(1)}%)`);
        rugScore += Math.round(30 * timeDampener); // FIX 2: structural signal dampened
      } else if (top10Spike > 20) {
        signals.push(`Top10 consolidating +${top10Spike.toFixed(0)}% — early warning`);
        rugScore += Math.round(15 * timeDampener); // FIX 2: structural signal dampened
      }
    }

    // Signal 3: Liquidity REMOVED (LP = $0) — instant rug
    if (snap.liquidity > 1000 && curLiq === 0) {
      signals.push(`Liquidity REMOVED ($${Math.round(snap.liquidity).toLocaleString()} → $0)`);
      rugScore += 100;
    }
    // Signal 3b: Liquidity drain — EARLY at 20% (+20), EXIT at 35% (+40)
    else if (snap.liquidity > 1000 && curLiq > 0) {
      const liqDrop = ((snap.liquidity - curLiq) / snap.liquidity) * 100;
      if (liqDrop > 35) {
        signals.push(`Liquidity drained ${liqDrop.toFixed(0)}% ($${Math.round(snap.liquidity).toLocaleString()} → $${Math.round(curLiq).toLocaleString()})`);
        rugScore += 40;
      } else if (liqDrop > 20) {
        signals.push(`Liquidity draining ${liqDrop.toFixed(0)}% — early warning`);
        rugScore += 20;
      }
    }

    // Signal 4: Sell/buy volume imbalance in 5m window — pre-rug pressure
    if (curSellVol5m > 0) {
      if (curBuyVol5m === 0) {
        signals.push(`Zero buys in 5m, sells only ($${Math.round(curSellVol5m).toLocaleString()})`);
        rugScore += 35;
      } else if (curSellVol5m / curBuyVol5m > 5) {
        signals.push(`Sell/buy ratio ${(curSellVol5m/curBuyVol5m).toFixed(1)}x in 5m ($${Math.round(curSellVol5m).toLocaleString()} vs $${Math.round(curBuyVol5m).toLocaleString()})`);
        rugScore += 30;
      } else if (curSellVol5m / curBuyVol5m > 3) {
        signals.push(`Sell pressure ${(curSellVol5m/curBuyVol5m).toFixed(1)}x vs buys in 5m`);
        rugScore += 15;
      }
    }

    // Signal 5: Trade count dominance in 5m
    if (curSells5m + curBuys5m > 5) {
      const sellRatio = curSells5m / (curSells5m + curBuys5m);
      if (sellRatio > 0.80) {
        signals.push(`${(sellRatio*100).toFixed(0)}% of 5m trades are sells (${curSells5m}/${curSells5m+curBuys5m})`);
        rugScore += 20;
      }
    }

    // FIX 6: Signal 5b — Rapid sell velocity spike (1m window)
    const curSellVol1m = parseFloat(stat.sell_volume_1m || 0);
    const prevSellVol1m = pos._prevSellVol1m || 0;
    const prevSellVol1mTs = pos._prevSellVol1mTs || 0;
    if (prevSellVol1m > 0 && prevSellVol1mTs > 0 && (Date.now() - prevSellVol1mTs) < 6000) {
      const sellVolRatio = curSellVol1m / prevSellVol1m;
      if (sellVolRatio > 8) {
        signals.push(`Sell volume surged ${sellVolRatio.toFixed(1)}x in ${((Date.now() - prevSellVol1mTs)/1000).toFixed(0)}s — dump wave`);
        rugScore += 30;
      } else if (sellVolRatio > 4) {
        signals.push(`Sell volume spike ${sellVolRatio.toFixed(1)}x — accelerating sells`);
        rugScore += 15;
      }
    }
    pos._prevSellVol1m = curSellVol1m;
    pos._prevSellVol1mTs = Date.now();

    // Signal 6: Jupiter price impact (absolute + rate of change)
    const lastImpact = parseFloat(pos._lastPriceImpact || 0);
    const prevImpact = parseFloat(pos._prevPriceImpact || 0);
    const prevImpactTs = pos._prevPriceImpactTs || 0;
    const impactAgeMs = Date.now() - prevImpactTs;

    if (lastImpact > 10) {
      signals.push(`Price impact ${lastImpact.toFixed(1)}% — LP nearly empty`);
      rugScore += 40;
    } else if (lastImpact > 3) {
      signals.push(`Price impact ${lastImpact.toFixed(1)}% — thinning LP`);
      rugScore += 20;
    }

    if (prevImpact > 0 && impactAgeMs > 0 && impactAgeMs < 60000) {
      const growthRatio = lastImpact / prevImpact;
      if (growthRatio >= 3 && lastImpact > 2) {
        signals.push(`Price impact tripled in ${(impactAgeMs/1000).toFixed(0)}s (${prevImpact.toFixed(1)}% → ${lastImpact.toFixed(1)}%) — LP withdrawal`);
        rugScore += 35;
      } else if (growthRatio >= 2 && lastImpact > 2) {
        signals.push(`Price impact doubled in ${(impactAgeMs/1000).toFixed(0)}s (${prevImpact.toFixed(1)}% → ${lastImpact.toFixed(1)}%)`);
        rugScore += 20;
      }
    }

    // Signal 7: Entrapment spike (was low, now high)
    if (curEntrapment > 0.15 && snap.entrapment < 0.05) {
      signals.push(`Entrapment spiked to ${(curEntrapment*100).toFixed(1)}% (was ${(snap.entrapment*100).toFixed(1)}%)`);
      rugScore += Math.round(20 * timeDampener); // FIX 2: structural signal dampened
    }

    // FIX 3: Signal 8 — Creator sell delta (replaced absolute hold check)
    if (snap.creatorHold > 0 && curCreatorHold > 0) {
      const creatorDrop = snap.creatorHold - curCreatorHold;
      if (creatorDrop > 0.20) {
        signals.push(`Creator dumped ${(creatorDrop*100).toFixed(1)}% (${(snap.creatorHold*100).toFixed(1)}% → ${(curCreatorHold*100).toFixed(1)}%)`);
        rugScore += Math.round(40 * timeDampener); // structural, dampened
      } else if (creatorDrop > 0.10) {
        signals.push(`Creator sold ${(creatorDrop*100).toFixed(1)}% (${(snap.creatorHold*100).toFixed(1)}% → ${(curCreatorHold*100).toFixed(1)}%)`);
        rugScore += Math.round(20 * timeDampener); // structural, dampened
      } else if (curCreatorHold > 0.95 && timeSinceBuySec > 300) {
        // Stubborn hold: creator still holds >95% after 5 min (no distribution = suspicious)
        signals.push(`Creator stubborn hold ${(curCreatorHold*100).toFixed(1)}% after ${Math.floor(timeSinceBuySec/60)}m`);
        rugScore += Math.round(15 * timeDampener); // structural, dampened
      }
    }

    // Signal 9: All fresh wallets (> 95%)
    if (curFreshWallet > 0.95) {
      signals.push(`${(curFreshWallet*100).toFixed(0)}% fresh wallets`);
      rugScore += Math.round(15 * timeDampener); // FIX 2: structural signal dampened
    }

    // FIX 5: Combined signal correlation — multi-category signals are more reliable
    const signalCategories = new Set();
    for (const sig of signals) {
      if (sig.includes('Holders')) signalCategories.add('holders');
      if (sig.includes('Top10') || sig.includes('Creator') || sig.includes('creator')) signalCategories.add('concentration');
      if (sig.includes('Liquidity') || sig.includes('liq') || sig.includes('LP')) signalCategories.add('liquidity');
      if (sig.includes('Sell') || sig.includes('sells')) signalCategories.add('selling');
      if (sig.includes('Price') || sig.includes('impact')) signalCategories.add('price');
      if (sig.includes('Entrapment')) signalCategories.add('entrapment');
    }
    if (signalCategories.size >= 3) {
      rugScore = Math.min(100, Math.round(rugScore * 1.4));
    } else if (signalCategories.size >= 2) {
      rugScore = Math.min(100, Math.round(rugScore * 1.2));
    }

    // Graduated response: watch(10-29) → warn(30-49) → partial(50-74) → exit(75+)
    const rugLevel = rugScore >= 75 ? 'exit' : rugScore >= 50 ? 'partial' : rugScore >= 30 ? 'warn' : rugScore > 0 ? 'watch' : 'safe';

    // EMA smoothing for rug score (prevents oscillation causing missed confirmations)
    const alpha = 0.6;
    if (!pos._emaRugScore) pos._emaRugScore = rugScore;
    else pos._emaRugScore = pos._emaRugScore * (1 - alpha) + rugScore * alpha;
    const smoothedScore = Math.round(pos._emaRugScore);
    const smoothedLevel = smoothedScore >= 75 ? 'exit' : smoothedScore >= 50 ? 'partial' : smoothedScore >= 30 ? 'warn' : smoothedScore > 0 ? 'watch' : 'safe';

    return { isRug: smoothedScore >= 30, signals, rugScore: smoothedScore, rawRugScore: rugScore, rugLevel: smoothedLevel, lpRemoved: rugScore >= 100 };

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
          if (holderDrop > 25) {
            signals.push(`Holders dropped ${holderDrop.toFixed(0)}% (${snap.holders} → ${retryHolders})`);
            rugScore += 30;
          } else if (holderDrop > 15) {
            signals.push(`Holders dropping ${holderDrop.toFixed(0)}% — early warning`);
            rugScore += 15;
          }
        }
        if (snap.liquidity > 1000 && retryLiq > 0) {
          const liqDrop = ((snap.liquidity - retryLiq) / snap.liquidity) * 100;
          if (liqDrop > 35) {
            signals.push(`Liquidity drained ${liqDrop.toFixed(0)}% ($${Math.round(snap.liquidity)} → $${Math.round(retryLiq)})`);
            rugScore += 40;
          } else if (liqDrop > 20) {
            signals.push(`Liquidity draining ${liqDrop.toFixed(0)}% — early warning`);
            rugScore += 20;
          }
        }
        if (retryTop10 > 0 && snap.top10 > 0) {
          const top10Spike = ((retryTop10 - snap.top10) / snap.top10) * 100;
          if (top10Spike > 30) {
            signals.push(`Top10 spiked ${top10Spike.toFixed(0)}% (${(snap.top10*100).toFixed(1)}% → ${(retryTop10*100).toFixed(1)}%)`);
            rugScore += 30;
          } else if (top10Spike > 20) {
            signals.push(`Top10 consolidating +${top10Spike.toFixed(0)}% — early warning`);
            rugScore += 15;
          }
        }

        if (signals.length > 0) {
          const retryLevel = rugScore >= 75 ? 'exit' : rugScore >= 50 ? 'partial' : rugScore >= 30 ? 'warn' : 'watch';
          return { isRug: rugScore >= 30, signals, rugScore, rugLevel: retryLevel };
        }
        // Got data but no signals — not a rug
        return { isRug: false, signals: [], rugScore: 0, rugLevel: 'safe' };
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
          // Grace period: skip auto-close if manual sell was initiated recently (< 30s)
          if (pos._manualSellAt && (Date.now() - pos._manualSellAt) < 30000) {
            console.log(`[AUTO] ${pos.symbol}: wallet empty but manual sell pending, skipping`);
          } else {
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
        // Store for rug detector (priceImpact = LP depth signal, lastQuoteSol = value trend)
        const _impactUpdate = {
          _prevPriceImpact: pos._lastPriceImpact || 0,
          _prevPriceImpactTs: Date.now(),
          _lastPriceImpact: parseFloat(quote.priceImpactPct || 0),
          _lastQuoteSol: quoteSolOut,
        };
        if (pos.isDryRun) dryRun.updateDryPosition(pos.tokenMint, _impactUpdate);
        else { const { updatePosition: _upd } = require('./positions'); _upd(pos.tokenMint, _impactUpdate); }
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
        // TRAILING TP FIX: After partial sell reset, use remaining-only PNL (not total with realized gains)
        // This ensures the trailing TP tracks the REMAINING tokens' price action, not inflated total PNL
        const effectivePnlPct = pos._partialSellReset
          ? ((currentPrice / pos.entryPrice) - 1) * 100
          : pnlPct;
        const peakUpdate = { peakPrice: currentPrice, peakPnlPct: parseFloat(effectivePnlPct.toFixed(1)) };
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
      try { releaseSellLock(pos.tokenMint); } catch(_) {}
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
          // FIX 1: Bundler PNL Gate — don't panic-sell profitable positions
          const bundlerPnlPct = pos.solSpent > 0 ? (((pos.totalSolReceived || 0) - pos.solSpent) / pos.solSpent * 100) : -100;
          const bundlerAgeMs = Date.now() - (pos.gmgnSnapshot?.snapshotAt || pos.openedAt || Date.now());

          if (bundlerPnlPct > 5) {
            // Profitable: alert only, don't sell
            console.log(`[BUNDLER] 👀 ${pos.symbol}: bundler detected but PNL +${bundlerPnlPct.toFixed(1)}% — alert only, NOT selling`);
            const bundlerWatchMsg = [
              `👀 <b>BUNDLER (Watch Only): ${pos.symbol}</b>`, ``,
              `PNL: +${bundlerPnlPct.toFixed(1)}% — profitable, not selling`,
              ``, `⚠️ Pattern: ${bundlerResult.details}`,
              `Transfers: ${bundlerResult.transfers} | Payers: ${bundlerResult.uniquePayers}`,
            ].join('\n');
            sendTelegram(bundlerWatchMsg, { parse_mode: 'HTML' }).catch(() => {});
            continue;
          }
          if (bundlerAgeMs < 180000 && bundlerPnlPct > -5) {
            // Young position, not in deep loss: watch mode
            console.log(`[BUNDLER] 👀 ${pos.symbol}: bundler detected, age ${(bundlerAgeMs/1000).toFixed(0)}s, PNL ${bundlerPnlPct.toFixed(1)}% — watch mode`);
            const bundlerWatchMsg = [
              `👀 <b>BUNDLER (Watch): ${pos.symbol}</b>`, ``,
              `PNL: ${bundlerPnlPct.toFixed(1)}% — age ${(bundlerAgeMs/1000).toFixed(0)}s, monitoring`,
              ``, `⚠️ Pattern: ${bundlerResult.details}`,
              `Transfers: ${bundlerResult.transfers} | Payers: ${bundlerResult.uniquePayers}`,
            ].join('\n');
            sendTelegram(bundlerWatchMsg, { parse_mode: 'HTML' }).catch(() => {});
            continue;
          }
          // Otherwise: proceed with sell (confirmed dump or old + losing position)

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

// ─── Unified Safety Loop (2s) ────────────────────────────────
// Replaces: tick (15s) + softSlTick (3s) + rugTick (2s)
// Single loop with shared cache, priority queue, and all checks
let unifiedRunning = false;
let unifiedRunningSince = 0;
let _unifiedTickNum = 0;

async function unifiedTick() {
  // Watchdog: force-reset if stuck > 2 minutes
  if (unifiedRunning) {
    if (Date.now() - unifiedRunningSince > 120_000) {
      console.error('[UNIFIED] WATCHDOG: stuck for 2min, force-resetting');
      unifiedRunning = false;
    } else {
      return;
    }
  }
  unifiedRunning = true;
  unifiedRunningSince = Date.now();
  jupiterCallsThisTick = 0;

  try {
    const isDryMode = autoConfig.mode === 'dry_run';
    let allPos = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();
    if (!allPos.length) return;

    // PRIORITY QUEUE: sort by urgency
    allPos = [...allPos].sort((a, b) => {
      const scoreA = (a.softSlTriggeredAt ? 1000 : 0)
        + (a._rugConfLevel ? 500 : 0)
        + ((a._emaRugScore || a._lastRugScore || 0) > 40 ? 200 : 0)
        + (a._emaRugScore || a._lastRugScore || 0);
      const scoreB = (b.softSlTriggeredAt ? 1000 : 0)
        + (b._rugConfLevel ? 500 : 0)
        + ((b._emaRugScore || b._lastRugScore || 0) > 40 ? 200 : 0)
        + (b._emaRugScore || b._lastRugScore || 0);
      return scoreB - scoreA;
    });

    for (let i = 0; i < allPos.length; i++) {
      _unifiedTickNum++;
      const pos = allPos[i];
      try {
        await Promise.race([
          processUnifiedPosition(pos, isDryMode),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('processUnifiedPosition timeout (30s)')), 30_000)
          )
        ]);
      } catch (tickErr) {
        console.error(`[UNIFIED] ${pos.symbol}: tick error — ${tickErr.message}`);
        try { releaseSellLock(pos.tokenMint); } catch (_) {}
      }
      // Stagger: 500ms between positions
      if (i < allPos.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (e) {
    console.error('[UNIFIED] Loop error:', e.message);
  } finally {
    unifiedRunning = false;
    unifiedRunningSince = 0;
    setTimeout(unifiedTick, 2000);
  }
}

// ─── Process Single Position (unified) ───────────────────────
async function processUnifiedPosition(pos, isDryMode) {
  const checkNow = Date.now();

  // ─── Wallet balance check (every 5th tick, live only, ~10s) ───
  if (!isDryMode && _unifiedTickNum % 5 === 0) {
    try {
      const walletBal = await getTokenBalance(pos.tokenMint);
      if (walletBal.amount <= 0) {
        // Grace period: skip auto-close if manual sell was initiated recently (< 30s)
        // Prevents wallet_empty race condition when user clicks sell button
        if (pos._manualSellAt && (Date.now() - pos._manualSellAt) < 30000) {
          console.log(`[UNIFIED] ${pos.symbol}: wallet empty but manual sell pending (${((Date.now() - pos._manualSellAt) / 1000).toFixed(0)}s ago), skipping auto-close`);
        } else {
          const pnl = (pos.totalSolReceived || 0) - (pos.solSpent || 0);
          closePosition(pos.tokenMint, 0, 'none', 'wallet_empty');
          setPostCloseLock(pos.tokenMint);
          console.log(`[UNIFIED] ${pos.symbol}: wallet empty, auto-closed (PNL: ${pnl.toFixed(4)} SOL)`);
          sendTelegram(
            `🧹 <b>Auto-Closed: ${pos.symbol}</b>\n\n` +
            `📊 Wallet balance = 0\n` +
            `💰 PNL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          return;
        }
      }
    } catch (_) {}
  }

  // ─── STEP 1: GMGN fetch (shared cache, 2s TTL) ───
  let gmgnData = null;
  try {
    gmgnData = await gmgnFetchCached('sol', pos.tokenMint);
  } catch (gmgnErr) {
    console.log(`[UNIFIED] ${pos.symbol}: GMGN fetch failed (${gmgnErr.message?.slice(0, 50)})`);
  }

  // ─── STEP 1a: Dead token (0 holders + $0 liq) ───
  if (gmgnData) {
    const gPool = gmgnData.pool || {};
    const gHolders = gmgnData.holder_count || 0;
    const gLiq = parseFloat(gPool.liquidity || 0);
    if (gHolders === 0 && gLiq === 0) {
      updatePosField(pos, isDryMode, { lastRugCheck: checkNow });
      console.log(`[UNIFIED] ${pos.symbol}: GMGN dead (0 holders, $0 liq)`);
      if (acquireSellLock(pos.tokenMint)) {
        await executeFullExit(pos, 'rug_gmgn_dead', 0, { lockHeld: true });
      }
      return;
    }
  }

  // ─── STEP 1b: Top10 absolute exit ───
  if (gmgnData && autoConfig.top10ExitEnabled !== false) {
    const gDev = gmgnData.dev || {};
    const curTop10Abs = parseFloat(gDev.top_10_holder_rate || 0);
    const ageMs = pos.openedAt ? (Date.now() - new Date(pos.openedAt).getTime()) : 0;
    const top10Threshold = (autoConfig.top10ExitPct || 24) / 100;
    const top10MinAgeMs = (autoConfig.top10ExitMinAgeSec || 300) * 1000;
    if (ageMs > top10MinAgeMs && curTop10Abs > top10Threshold) {
      updatePosField(pos, isDryMode, { lastRugCheck: checkNow });
      console.log(`[UNIFIED] ${pos.symbol}: Top10 ${(curTop10Abs*100).toFixed(1)}% > ${autoConfig.top10ExitPct || 24}% (age ${Math.round(ageMs/60000)}min)`);
      const top10Msg = [
        `🚨 <b>TOP10 EXIT: ${pos.symbol}</b>`, ``,
        `Top10 holders: <b>${(curTop10Abs*100).toFixed(1)}%</b>`,
        `Age: ${Math.round(ageMs/60000)} min`,
        `PNL: ${pos.solSpent > 0 ? (((pos.totalSolReceived || 0) - pos.solSpent) / pos.solSpent * 100).toFixed(1) : '?'}%`,
      ].join('\n');
      sendTelegram(top10Msg, { parse_mode: 'HTML' }).catch(() => {});
      if (acquireSellLock(pos.tokenMint)) {
        await executeFullExit(pos, `Top10 absolute ${(curTop10Abs*100).toFixed(1)}%`, 0, { lockHeld: true });
      }
      return;
    }
  }

  // ─── STEP 1c: Liquidity drain (throttled 10s per pos) ───
  if (autoConfig.liqDrainEnabled !== false && gmgnData) {
    const lastLiqCheck = pos._lastLiqCheck || 0;
    const liqCheckInterval = (autoConfig.liqDrainCheckSec || 10) * 1000;
    if (checkNow - lastLiqCheck >= liqCheckInterval) {
      const gPool = gmgnData.pool || {};
      const rawLiq = gPool.liquidity;
      const curLiq = parseFloat(rawLiq);
      const entryLiq = pos.gmgnSnapshot?.liquidity || 0;
      const liqMinLiq = autoConfig.liqDrainMinLiq || 1000;

      if (entryLiq >= liqMinLiq && Number.isFinite(curLiq)) {
        updatePosField(pos, isDryMode, { _lastLiqCheck: checkNow });

        if (curLiq === 0 && entryLiq > 0) {
          console.log(`[UNIFIED] ${pos.symbol}: liq dropped to $0 — instant exit`);
          if (acquireSellLock(pos.tokenMint)) {
            try {
              const closeResult = await sellAll(pos.tokenMint, autoConfig.walletLabel, 500);
              if (closeResult?.success) {
                const closed = closePosition(pos.tokenMint, closeResult.outputSol, closeResult.signature, 'liq_drain_100%');
                setPostCloseLock(pos.tokenMint);
                releaseSellLock(pos.tokenMint);
                const emoji = (closed.pnl || 0) >= 0 ? '🟢' : '🔴';
                sendTelegram(`${emoji} <b>Liq Drain 100%: ${pos.symbol}</b>\n\nGot: ${(closeResult.outputSol || 0).toFixed(4)} SOL\nPNL: ${(closed.pnl || 0) >= 0 ? '+' : ''}${(closed.pnl || 0).toFixed(4)} SOL`, { parse_mode: 'HTML' }).catch(() => {});
              } else {
                closePosition(pos.tokenMint, 0, '', 'liq_drain_no_routes');
                setPostCloseLock(pos.tokenMint);
                releaseSellLock(pos.tokenMint);
              }
            } catch (sellErr) {
              releaseSellLock(pos.tokenMint);
              console.error(`[UNIFIED] ${pos.symbol}: liq drain sell failed: ${sellErr.message}`);
            }
          }
          return;
        }

        if (curLiq > 0 && entryLiq > 0) {
          const liqDrop = ((entryLiq - curLiq) / entryLiq) * 100;
          const liqWarnPct = autoConfig.liqDrainWarnPct || 30;
          const liqExitPct = pos.gmgnSnapshot?.entryRiskScore >= 60
            ? Math.min(autoConfig.liqDrainExitPct || 50, 20)
            : (autoConfig.liqDrainExitPct || 50);

          if (liqDrop >= liqExitPct) {
            console.log(`[UNIFIED] ${pos.symbol}: liq drain ${liqDrop.toFixed(0)}% ($${Math.round(entryLiq)} -> $${Math.round(curLiq)}) — exit`);
            if (acquireSellLock(pos.tokenMint)) {
              await executeFullExit(pos, `Liq Drain (-${liqDrop.toFixed(0)}%)`, 0, { lockHeld: true });
            }
            return;
          } else if (liqDrop >= liqWarnPct && !pos._liqWarnSent) {
            updatePosField(pos, isDryMode, { _liqWarnSent: true });
            sendTelegram(`⚠️ <b>Liq Warning: ${pos.symbol}</b>\n\nLiq: $${Math.round(entryLiq)} -> $${Math.round(curLiq)} (-${liqDrop.toFixed(0)}%)`, { parse_mode: 'HTML' }).catch(() => {});
          }
        }
      }
    }
  }

  // ─── STEP 2: Rug signals (use cached GMGN, no refetch) ───
  const cachedLastQuoteSol = pos._lastRugQuoteSol || 0;
  const rugResult = await checkRugSignals(pos, gmgnData, cachedLastQuoteSol);
  updatePosField(pos, isDryMode, { _lastRugScore: rugResult.rawRugScore || rugResult.rugScore || 0, _emaRugScore: pos._emaRugScore });

  // ─── STEP 3: Jupiter quote (conditional + global cap) ───
  let quoteSolOut = 0;
  let needJupiter = false;

  const softSlPct = autoConfig.softSlPct || 20;
  const hardSlPct = autoConfig.hardSlPct || autoConfig.slPct || 25;
  const estimatedPnl = pos.solSpent > 0 ? (((pos._lastRugQuoteSol || 0) + (pos.totalSolReceived || 0)) - pos.solSpent) / pos.solSpent * 100 : 0;

  // SL-critical positions: always fetch
  if (pos.softSlTriggeredAt) needJupiter = true;
  else if (estimatedPnl < -(hardSlPct - 5)) needJupiter = true;
  else if (gmgnData) {
    const gPool = gmgnData.pool || {};
    const gStat = gmgnData.stat || {};
    const gHolders = gmgnData.holder_count || 0;
    const gLiq = parseFloat(gPool.liquidity || 0);
    const gSellVol5m = parseFloat(gStat.sell_volume_5m || 0);
    const gBuyVol5m = parseFloat(gStat.buy_volume_5m || 0);
    const snap = pos.gmgnSnapshot;
    if (snap && snap.holders > 10 && gHolders > 0 && ((snap.holders - gHolders) / snap.holders) > 0.10) needJupiter = true;
    if (snap && snap.liquidity > 1000 && gLiq > 0 && ((snap.liquidity - gLiq) / snap.liquidity) > 0.15) needJupiter = true;
    if (gSellVol5m > 0 && gBuyVol5m > 0 && gSellVol5m / gBuyVol5m > 3) needJupiter = true;
    if (gSellVol5m > 0 && gBuyVol5m === 0) needJupiter = true;
  }
  // Normal: every 3rd tick
  if (!needJupiter && _unifiedTickNum % 3 === 0) needJupiter = true;

  // Global cap (SL-critical positions exempt)
  const isSlCritical = pos.softSlTriggeredAt || estimatedPnl < -(hardSlPct - 5);
  if (needJupiter && jupiterCallsThisTick >= MAX_JUPITER_PER_TICK && !isSlCritical) {
    needJupiter = false;
    console.log(`[UNIFIED] ${pos.symbol}: Jupiter cap (${MAX_JUPITER_PER_TICK}/tick), using cached`);
  }

  if (needJupiter) {
    try {
      const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals || 6));
      if (rawAmount > 0 && pos.remainingTokens > 0) {
        const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
        quoteSolOut = parseFloat(quote.outAmount) / 1e9;
        jupiterCallsThisTick++;
        pos._lastRugQuoteSol = quoteSolOut;
        setCachedJupiter(pos.tokenMint, rawAmount, quote);
        const _impactUpdate = {
          _prevPriceImpact: pos._lastPriceImpact || 0,
          _prevPriceImpactTs: Date.now(),
          _lastPriceImpact: parseFloat(quote.priceImpactPct || 0),
          _lastQuoteSol: quoteSolOut,
        };
        updatePosField(pos, isDryMode, _impactUpdate);
        if (pos.quoteFailCount > 0) updatePosField(pos, isDryMode, { quoteFailCount: 0 });
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('429') || msg.includes('Too many requests')) {
        console.log(`[UNIFIED] ${pos.symbol}: Jupiter 429, using cached`);
        quoteSolOut = pos._lastRugQuoteSol || 0;
      } else if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
        const failCount = (pos.quoteFailCount || 0) + 1;
        if (failCount >= 3) {
          updatePosField(pos, isDryMode, { lastRugCheck: checkNow });
          console.log(`[UNIFIED] ${pos.symbol}: NO_ROUTES x3, auto-closing`);
          if (acquireSellLock(pos.tokenMint)) {
            await executeFullExit(pos, 'dead_token', 0, { lockHeld: true });
          }
          return;
        }
        updatePosField(pos, isDryMode, { quoteFailCount: failCount });
        console.log(`[UNIFIED] ${pos.symbol}: NO_ROUTES (${failCount}/3)`);
        // GMGN price fallback
        try {
          const gmgnPrice = await gmgnTokenInfo(pos.tokenMint);
          const gmgnPriceUSD = parseFloat(gmgnPrice?.price?.price || 0);
          if (gmgnPriceUSD > 0) {
            const solPrice = await getSolPriceUsd();
            if (solPrice > 0) {
              quoteSolOut = (gmgnPriceUSD / solPrice) * pos.remainingTokens;
              console.log(`[UNIFIED] ${pos.symbol}: GMGN fallback $${gmgnPriceUSD} -> ${quoteSolOut.toFixed(4)} SOL`);
            }
          }
        } catch (_) {}
      } else {
        console.log(`[UNIFIED] ${pos.symbol}: Jupiter error: ${msg.slice(0, 50)}`);
        quoteSolOut = pos._lastRugQuoteSol || 0;
      }
    }
  } else {
    quoteSolOut = pos._lastRugQuoteSol || 0;
  }

  if (!quoteSolOut) return;

  // ─── STEP 4: PNL calculation ───
  const currentValueSol = quoteSolOut;
  const totalValueSol = currentValueSol + (pos.totalSolReceived || 0);
  const pnlSol = totalValueSol - pos.solSpent;
  const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;
  const currentPrice = pos.remainingTokens > 0 ? currentValueSol / pos.remainingTokens : 0;
  // Remaining-only PNL: based on current price vs entry, ignores partial proceeds
  // Used for hard SL check so partial sells don't buffer the stop-loss threshold
  const remainingPnlPct = pos.entryPrice > 0 ? ((currentPrice / pos.entryPrice) - 1) * 100 : pnlPct;

  updatePosField(pos, isDryMode, { lastRugCheck: checkNow });

  // Rug warning at -90%
  if (pnlPct <= -90 && !pos.rugWarningSent) {
    updatePosField(pos, isDryMode, { rugWarningSent: true });
    sendTelegram(`🚨 <b>RUG WARNING: ${pos.symbol}</b>\n\nPNL: <b>${pnlPct.toFixed(1)}%</b>\nMassive dump detected!`, { parse_mode: 'HTML' }).catch(() => {});
  }

  // Peak update
  if (currentPrice > (pos.peakPrice || 0)) {
    const effectivePnlPct = pos._partialSellReset
      ? ((currentPrice / pos.entryPrice) - 1) * 100
      : pnlPct;
    updatePosField(pos, isDryMode, { peakPrice: currentPrice, peakPnlPct: parseFloat(effectivePnlPct.toFixed(1)) });
  }

  // ─── STEP 5: Collect actions (PRIORITY ORDER) ───
  const actions = [];

  // P1: Hard SL (instant, no consecutive confirm) — priority 1 (trailing is 0)
  if (remainingPnlPct <= -hardSlPct) {
    actions.push({ type: 'hard_sl', pnlPct, priority: 1 });
  }

  // P0: Rug signals (from Step 2) — HIGHER priority than hard_sl
  const rugLevel = rugResult.rugLevel || 'safe';
  const rugScore = rugResult.rugScore || 0;

  if (rugLevel === 'exit' && rugScore >= 75) {
    // Instant exit for high-confidence rug (score 80+ or LP=0)
    const isHighConf = rugScore >= 80 || rugResult.lpRemoved;
    if (isHighConf) {
      console.log(`[UNIFIED] ${pos.symbol}: HIGH-CONF RUG (score ${rugScore}, lpRemoved=${!!rugResult.lpRemoved}) — instant exit`);
      actions.push({ type: 'rug_exit', rugResult, priority: 0 });
    } else {
      // Consecutive confirmation for medium-confidence rug (12s window)
      const rugConfLevel = pos._rugConfLevel || '';
      const rugConfTs = pos._rugConfTs || 0;
      const rugConfCount = pos._rugConfCount || 0;
      const confAge = Date.now() - rugConfTs;
      if (rugConfLevel !== 'exit' || confAge > 12000) {
        updatePosField(pos, isDryMode, { _rugConfLevel: 'exit', _rugConfTs: Date.now(), _rugConfCount: 1 });
        console.log(`[UNIFIED] ${pos.symbol}: rug exit (score ${rugScore}) — confirming...`);
      } else {
        updatePosField(pos, isDryMode, { _rugConfCount: 2 });
        actions.push({ type: 'rug_exit', rugResult, priority: 0 });
      }
    }
  } else if (rugLevel === 'partial' && rugScore >= 50 && !pos._rugPartialSold) {
    // Consecutive confirmation with 12s window
    const rugConfLevel = pos._rugConfLevel || '';
    const rugConfTs = pos._rugConfTs || 0;
    const rugConfCount = pos._rugConfCount || 0;
    const confAge = Date.now() - rugConfTs;
    if (rugConfLevel !== 'partial' || confAge > 12000) {
      updatePosField(pos, isDryMode, { _rugConfLevel: 'partial', _rugConfTs: Date.now(), _rugConfCount: 1 });
      console.log(`[UNIFIED] ${pos.symbol}: rug partial (score ${rugScore}) — confirming...`);
    } else {
      // 2nd tick within 5s — CONFIRMED
      updatePosField(pos, isDryMode, { _rugConfCount: 2 });
      actions.push({ type: 'rug_partial', rugResult, priority: 2 });
    }
  }

  // Clear rug confirmation if level dropped
  if (rugLevel === 'safe' || rugLevel === 'watch') {
    if (pos._rugConfLevel) {
      updatePosField(pos, isDryMode, { _rugConfLevel: '', _rugConfTs: 0, _rugConfCount: 0 });
    }
  }

  // Rug warn alert
  if (rugLevel === 'warn' && (pos._rugWarnLevel || 'safe') === 'safe') {
    updatePosField(pos, isDryMode, { _rugWarnLevel: 'warn' });
    const warnMsg = [
      `⚠️ <b>RUG EARLY WARNING: ${pos.symbol}</b>`, ``,
      `PNL: ${pnlPct.toFixed(1)}%  Score: ${rugScore}`, ``,
      `⚠️ Signals:`, ...rugResult.signals.map(s => `• ${s}`),
      ``, `Watching — will sell if signals escalate.`,
    ].join('\n');
    sendTelegram(warnMsg, { parse_mode: 'HTML' }).catch(() => {});
  } else if (rugLevel !== 'warn' && pos._rugWarnLevel === 'warn') {
    updatePosField(pos, isDryMode, { _rugWarnLevel: 'safe' });
  }

  // P3: Trailing TP
  if (pos.trailingEnabled && pos.peakPrice) {
    const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice * 100);
    const peakPnl = pos.peakPnlPct || 0;
    const triggerPct = autoConfig.trailingTriggerPct || pos.trailingTriggerPct || 20;
    if (peakPnl > triggerPct && dropFromPeak >= (pos.trailingDropPct || 15)) {
      actions.push({ type: 'trailing', dropFromPeak: dropFromPeak.toFixed(1), peakPnl, priority: 0 });
    }
  }

  // P4: Partial sell (PNL levels)
  const pendingPartials = (pos.partialSells || []).filter(s => !s.sold && s.enabled !== false);
  for (const partial of pendingPartials) {
    if (pnlPct >= partial.atPct) {
      actions.push({ type: 'partial', atPct: partial.atPct, sellPct: partial.sellPct, priority: 4 });
    }
  }

  // P5: Soft SL
  if (pnlPct <= -softSlPct && pnlPct > -hardSlPct) {
    const softSlWaitSec = autoConfig.softSlWaitSec || 30;
    if (!pos.softSlTriggeredAt) {
      updatePosField(pos, isDryMode, { softSlTriggeredAt: Date.now() });
      console.log(`[UNIFIED] ${pos.symbol}: Soft SL triggered (${pnlPct.toFixed(1)}%), waiting ${softSlWaitSec}s...`);
      sendTelegram(`⚠️ <b>Soft SL: ${pos.symbol}</b>\n\nPNL: ${pnlPct.toFixed(1)}%\nWaiting ${softSlWaitSec}s...`, { parse_mode: 'HTML' }).catch(() => {});
    } else {
      const elapsed = (Date.now() - pos.softSlTriggeredAt) / 1000;
      if (elapsed >= softSlWaitSec) {
        actions.push({ type: 'soft_sl', waited: Math.round(elapsed), pnlPct, priority: 5 });
      }
    }
  } else if (pnlPct > -softSlPct) {
    if (pos.softSlTriggeredAt) {
      updatePosField(pos, isDryMode, { softSlTriggeredAt: null, rugWarningSent: false });
      console.log(`[UNIFIED] ${pos.symbol}: Soft SL recovered! (${pnlPct.toFixed(1)}%)`);
      sendTelegram(`✅ <b>Soft SL Recovered: ${pos.symbol}</b>\n\nPNL: ${pnlPct.toFixed(1)}%`, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  // Sort by priority (lowest = most urgent)
  actions.sort((a, b) => a.priority - b.priority);

  if (actions.length > 0) {
    console.log(`[UNIFIED] ${pos.symbol}: PNL ${pnlPct.toFixed(1)}%, rug ${rugScore}, actions: [${actions.map(a=>a.type)}]`);
  }

  // ─── STEP 6: Execute actions ───
  for (const action of actions) {
    // Verify position still exists
    const currentPos = isDryMode
      ? dryRun.getOpenDryPositions().find(p => p.tokenMint === pos.tokenMint)
      : getPosition(pos.tokenMint);
    if (!currentPos) break;

    if (action.type === 'hard_sl') {
      if (!acquireSellLock(pos.tokenMint)) break;
      console.log(`[UNIFIED] ${pos.symbol}: HARD SL (${pnlPct.toFixed(1)}%)`);
      await executeFullExit(pos, `HARD SL (${pnlPct.toFixed(1)}%)`, quoteSolOut, { lockHeld: true });
      break;
    } else if (action.type === 'rug_exit') {
      if (!acquireSellLock(pos.tokenMint)) break;
      console.log(`[UNIFIED] ${pos.symbol}: RUG EXIT (score ${rugScore})`);
      const rugAlertMsg = [
        `🚨 <b>RUG SIGNAL DETECTED</b>`, ``,
        `Token: <b>${pos.symbol || 'Unknown'}</b>`,
        `CA: <code>${pos.tokenMint}</code>`,
        `PNL: ${pnlPct.toFixed(1)}%`, ``,
        `⚠️ Signals:`, ...rugResult.signals.map(s => `• ${s}`),
        ``, `Selling immediately...`,
      ].join('\n');
      sendTelegram(rugAlertMsg, { parse_mode: 'HTML' }).catch(() => {});
      await executeFullExit(pos, `rug_signal: ${rugResult.signals.join(', ')}`, quoteSolOut, { lockHeld: true });
      break;
    } else if (action.type === 'rug_partial') {
      if (!acquireSellLock(pos.tokenMint)) break;
      console.log(`[UNIFIED] ${pos.symbol}: RUG PARTIAL (score ${rugScore})`);
      const partialMsg = [
        `🟡 <b>RUG PARTIAL EXIT: ${pos.symbol}</b>`, ``,
        `PNL: ${pnlPct.toFixed(1)}%  Score: ${rugScore}`, ``,
        `⚠️ Signals:`, ...rugResult.signals.map(s => `• ${s}`),
        ``, `Selling 50% now...`,
      ].join('\n');
      sendTelegram(partialMsg, { parse_mode: 'HTML' }).catch(() => {});
      const freshPos = isDryMode ? dryRun.getOpenDryPositions().find(p => p.tokenMint === pos.tokenMint) : getPosition(pos.tokenMint);
      await executePartialSell(freshPos || pos, { sellPct: 50, atPct: -1, _lockHeld: true }, currentPrice);
      updatePosField(pos, isDryMode, { _rugPartialSold: true, _rugWarnLevel: 'partial' });
      releaseSellLock(pos.tokenMint);
    } else if (action.type === 'trailing') {
      if (!acquireSellLock(pos.tokenMint)) break;
      await executeFullExit(pos, `trailing (peak +${action.peakPnl}%, dropped ${action.dropFromPeak}%)`, quoteSolOut, { lockHeld: true });
      break;
    } else if (action.type === 'partial') {
      // executePartialSell handles its own sell lock
      await executePartialSell(pos, action, currentPrice);
      const freshPos = isDryMode ? dryRun.getOpenDryPositions().find(p => p.tokenMint === pos.tokenMint) : getPosition(pos.tokenMint);
      if (freshPos) Object.assign(pos, freshPos);
    } else if (action.type === 'soft_sl') {
      if (!acquireSellLock(pos.tokenMint)) break;
      console.log(`[UNIFIED] ${pos.symbol}: Soft SL expired (${action.waited}s)`);
      await executeFullExit(pos, `Soft SL (waited ${action.waited}s)`, quoteSolOut, { lockHeld: true });
      break;
    }
  }
}

// ─── Force-Probe Route (5s independent — catches stale-price LP pulls) ──
// Verifies Jupiter swap route exists even when Price API returns valid prices.
// Catches scenarios where LP was pulled but Price API still returns cached data.
let forceProbeRunning = false;
const FORCE_PROBE_INTERVAL_MS = 5000; // 5s
const FORCE_PROBE_FAIL_THRESHOLD = 2; // 2 consecutive fails → auto-close
const FORCE_PROBE_GRACE_MS = 60_000; // 60s grace period after buy

// Module-level import (avoid require() in hot loop)
let _probeGetQuote = null;
let _probeSOL_MINT = null;
function ensureProbeImports() {
  if (!_probeGetQuote) {
    const t = require('./trading');
    _probeGetQuote = t.getQuote;
    _probeSOL_MINT = t.SOL_MINT;
  }
}

async function forceProbeTick() {
  if (forceProbeRunning) {
    setTimeout(forceProbeTick, FORCE_PROBE_INTERVAL_MS);
    return;
  }
  forceProbeRunning = true;
  try {
    ensureProbeImports();
    const isDryMode = autoConfig.mode === 'dry_run';
    const allPos = isDryMode ? dryRun.getOpenDryPositions() : getOpenPositions();
    if (!allPos.length) return;

    for (let i = 0; i < allPos.length; i++) {
      const pos = allPos[i];

      // Grace period: skip positions bought within last 60s
      const ageMs = Date.now() - (pos.openedAt || 0);
      if (ageMs < FORCE_PROBE_GRACE_MS) continue;

      // Atomic lock check + acquire (no TOCTOU gap)
      if (!acquireSellLock(pos.tokenMint)) {
        // Another sell in progress — skip this position
        continue;
      }
      // We own the lock — release after probe (unless we trigger exit)
      let lockReleased = false;
      try {
        // Probe: quote selling entire remaining tokens to SOL
        const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals || 6));
        if (rawAmount <= 0) {
          releaseSellLock(pos.tokenMint);
          lockReleased = true;
          continue;
        }

        const quote = await _probeGetQuote(pos.tokenMint, _probeSOL_MINT, rawAmount, 500);

        if (quote && quote.outAmount && parseFloat(quote.outAmount) > 0) {
          // Route exists — reset fail count
          if ((pos._routeProbeFailCount || 0) > 0) {
            console.log(`[PROBE] ${pos.symbol}: route confirmed (was ${pos._routeProbeFailCount} fails)`);
          }
          pos._routeProbeFailCount = 0;
          releaseSellLock(pos.tokenMint);
          lockReleased = true;
        } else {
          // Quote returned but no output — count as fail
          pos._routeProbeFailCount = (pos._routeProbeFailCount || 0) + 1;
          console.log(`[PROBE] ${pos.symbol}: no route output (${pos._routeProbeFailCount}/${FORCE_PROBE_FAIL_THRESHOLD})`);
          releaseSellLock(pos.tokenMint);
          lockReleased = true;
        }
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('429') || msg.includes('Too many requests')) {
          // Rate limited — don't count as fail, skip this tick
          console.log(`[PROBE] ${pos.symbol}: 429 rate limited, skipping`);
          if (!lockReleased) releaseSellLock(pos.tokenMint);
          continue;
        }
        // Quote failed (NO_ROUTES, timeout, etc.) — count as fail
        pos._routeProbeFailCount = (pos._routeProbeFailCount || 0) + 1;
        console.log(`[PROBE] ${pos.symbol}: quote failed (${pos._routeProbeFailCount}/${FORCE_PROBE_FAIL_THRESHOLD}) — ${msg.slice(0, 60)}`);
        if (!lockReleased) releaseSellLock(pos.tokenMint);
      }

      // Auto-close after threshold (re-acquire lock for exit)
      if ((pos._routeProbeFailCount || 0) >= FORCE_PROBE_FAIL_THRESHOLD) {
        console.log(`[PROBE] ${pos.symbol}: route probe failed ${FORCE_PROBE_FAIL_THRESHOLD}x — auto-closing`);

        // Re-acquire lock for exit (released above during probe)
        if (!acquireSellLock(pos.tokenMint)) {
          console.log(`[PROBE] ${pos.symbol}: sell lock held by another loop, skipping exit`);
          continue;
        }

        try {
          const lastQuote = pos._lastRugQuoteSol || 0;
          // executeFullExit with lockHeld=true releases the lock internally
          await executeFullExit(pos, 'route_probe_failed', lastQuote, { lockHeld: true });
          setPostCloseLock(pos.tokenMint);

          await sendTelegram(
            `🔍 <b>Force-Probe: ${pos.symbol}</b>\n\n` +
            `⚠️ Jupiter route消失 (2x consecutive fails)\n` +
            `💰 LP likely pulled — auto-closed to prevent holding dead token`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } catch (exitErr) {
          console.error(`[PROBE] ${pos.symbol}: exit failed — ${exitErr.message}`);
          // executeFullExit releases lock on success OR throws on failure
          // Only release if executeFullExit threw (lock wasn't released)
          releaseSellLock(pos.tokenMint);
        }
      }

      // Stagger: 200ms between positions
      if (i < allPos.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (e) {
    console.error('[PROBE] Loop error:', e.message);
  } finally {
    forceProbeRunning = false;
    setTimeout(forceProbeTick, FORCE_PROBE_INTERVAL_MS);
  }
}

// ─── Start Position Monitor ────────────────────────────
function startMonitor() {
  if (monitoring) return;
  monitoring = true;
  loadAutoConfig();

  const modeTag = autoConfig.mode === 'dry_run' ? ' [DRY RUN]' : ' [LIVE]';
  console.log(`[AUTO] Monitor started${modeTag} (unified 2s + bundler 3s + force-probe 5s, max ${MAX_JUPITER_PER_TICK} Jupiter/tick)`);

  // Unified safety loop (replaces tick + softSlTick + rugTick)
  setTimeout(unifiedTick, 1000);

  // Bundler fast loop (3s independent — catches bursts before dump)
  async function bundlerTick() {
    try { await checkBundlers(); }
    catch (e) { console.error('[BUNDLER] Tick error:', e.message); }
    setTimeout(bundlerTick, 3000);
  }
  setTimeout(bundlerTick, 1000); // start after 1s

  // Force-probe loop (5s independent — catches stale-price LP pulls)
  setTimeout(forceProbeTick, 2000); // start after 2s (offset from bundler)
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
