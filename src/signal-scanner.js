/**
 * Signal Scanner — third discovery source alongside Trending and Trenches
 * Fetches token signals from GMGN, applies scoring adjustment, feeds into shared pipeline
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const GLOBAL_DEDUP_FILE = path.join(OUTPUT_DIR, 'gmgn-seen-global.json');
const SIGNAL_SEEN_FILE = path.join(OUTPUT_DIR, 'gmgn-seen-signal.json');

// ─── Default Signal Config ─────────────────────────────
const DEFAULT_SIGNAL_CONFIG = {
  enabled: true,
  intervalSec: 30,
  mcMin: 10000,
  mcMax: 500000,
  signalRatio: 0.30,
  minContribution: 10,
  maxContribution: 25,
  antiDoubleCount: {
    enabled: true,
    factor: 0.5,
  },
  hardRejectSignals: [18],
  signalWeights: {
    1: 8,     // Price Spike
    2: -3,    // Price Dump
    3: 8,     // Volume Spike
    4: 10,    // Large Buy
    5: -5,    // Large Sell
    6: 12,    // Smart Money Buy
    7: -5,    // Smart Money Sell
    8: 10,    // KOL Buy
    9: -5,    // KOL Sell
    10: 8,    // New Wallet Influx
    11: 8,    // Holder Surge
    12: 5,    // Liquidity Add
    13: -5,   // Liquidity Remove
    // 14: not supported by GMGN API
    // 15: not supported by GMGN API
    // 16: not supported by GMGN API
    17: -3,   // Dev Activity
  },
};

// ─── Dedup Config ──────────────────────────────────────
const DEFAULT_DEDUP_CONFIG = {
  globalTtlSec: 300,  // 5 minutes
};

// ─── Load Signal Config ────────────────────────────────
function getSignalConfig() {
  try {
    const cfgFile = path.join(__dirname, '..', 'data', 'auto-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const signalCfg = cfg.signalScanner || {};
    const dedupCfg = cfg.dedup || {};
    return {
      ...DEFAULT_SIGNAL_CONFIG,
      ...signalCfg,
      antiDoubleCount: {
        ...DEFAULT_SIGNAL_CONFIG.antiDoubleCount,
        ...(signalCfg.antiDoubleCount || {}),
      },
      signalWeights: {
        ...DEFAULT_SIGNAL_CONFIG.signalWeights,
        ...(signalCfg.signalWeights || {}),
      },
      dedup: { ...DEFAULT_DEDUP_CONFIG, ...dedupCfg },
    };
  } catch {
    return { ...DEFAULT_SIGNAL_CONFIG, dedup: { ...DEFAULT_DEDUP_CONFIG } };
  }
}

// ═══════════════════════════════════════════════════════════
// GLOBAL DEDUP CACHE
// ═══════════════════════════════════════════════════════════

function loadGlobalDedup() {
  try {
    const data = JSON.parse(fs.readFileSync(GLOBAL_DEDUP_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}

function saveGlobalDedup(dedup) {
  const dir = path.dirname(GLOBAL_DEDUP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GLOBAL_DEDUP_FILE, JSON.stringify(dedup, null, 2));
}

/**
 * Check if token is in global dedup cache (not expired)
 * @returns {null|{firstSource, firstSeen, lastSeen}}
 */
function checkGlobalDedup(tokenAddress) {
  const dedup = loadGlobalDedup();
  const entry = dedup[tokenAddress];
  if (!entry) return null;

  const config = getSignalConfig();
  const ttlMs = (config.dedup?.globalTtlSec || 300) * 1000;
  const now = Date.now();

  if (now - entry.lastSeen > ttlMs) {
    return null; // expired
  }
  return entry;
}

/**
 * Set token in global dedup cache
 */
function setGlobalDedup(tokenAddress, source) {
  const dedup = loadGlobalDedup();
  const now = Date.now();

  if (dedup[tokenAddress]) {
    dedup[tokenAddress].lastSeen = now;
  } else {
    dedup[tokenAddress] = {
      firstSource: source,
      firstSeen: now,
      lastSeen: now,
    };
  }
  saveGlobalDedup(dedup);
}

/**
 * Cleanup expired entries from global dedup
 */
function cleanupGlobalDedup() {
  const dedup = loadGlobalDedup();
  const config = getSignalConfig();
  const ttlMs = (config.dedup?.globalTtlSec || 300) * 1000;
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of Object.entries(dedup)) {
    if (now - entry.lastSeen > ttlMs) {
      delete dedup[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveGlobalDedup(dedup);
    console.log(`[DEDUP] Cleaned ${cleaned} expired entries`);
  }
}

// ═══════════════════════════════════════════════════════════
// SIGNAL SEEN (per-source dedup)
// ═══════════════════════════════════════════════════════════

function loadSignalSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SIGNAL_SEEN_FILE, 'utf8'));
    const now = Date.now();
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v.ts < 6 * 3600000) clean[k] = v; // 6h TTL
    }
    return clean;
  } catch { return {}; }
}

function saveSignalSeen(seen) {
  const dir = path.dirname(SIGNAL_SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SIGNAL_SEEN_FILE, JSON.stringify(seen, null, 2));
}

// ═══════════════════════════════════════════════════════════
// SIGNAL FETCHING
// ═══════════════════════════════════════════════════════════

/**
 * Fetch signals from GMGN CLI
 * @returns {Array} list of signal tokens
 */
function fetchSignals() {
  const config = getSignalConfig();
  if (!config.enabled) return [];

  try {
    // Build signal-type flags
    const activeTypes = Object.keys(config.signalWeights)
      .filter(t => config.signalWeights[t] !== 0)
      .map(t => `--signal-type ${t}`)
      .join(' ');

    const cmd = `gmgn-cli market signal --chain sol ${activeTypes} --mc-min ${config.mcMin} --mc-max ${config.mcMax} --raw`;
    console.log(`[SIGNAL] Fetching: ${cmd}`);

    const raw = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) return [];
    return data;
  } catch (e) {
    console.error(`[SIGNAL] Fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Parse signal token into screener-compatible format
 */
function parseSignalToken(signal) {
  const d = signal.data || {};
  const signalType = signal.signal_type;
  const signalTimes = signal.signal_times_by_type || {};

  return {
    // Token data (compatible with screener format)
    address: d.address || signal.token_address,
    symbol: d.symbol || '?',
    name: d.name || '',
    market_cap: d.market_cap || signal.trigger_mc || 0,
    fdv: d.usd_market_cap || signal.trigger_mc || 0,
    price: d.price || 0,
    price_usd: d.price_usd || 0,
    liquidity: d.liquidity || 0,
    volume_24h: d.volume_24h || 0,
    volume: d.swaps_24h ? (d.volume_24h || 0) : 0,
    buys_24h: d.buys_24h || 0,
    sells_24h: d.sells_24h || 0,
    buys: d.buys_24h || 0,
    sells: d.sells_24h || 0,
    holder_count: d.holder_count || 0,
    top_10_holder_rate: d.top_10_holder_rate || 0,
    smart_degen_count: d.smart_degen_count || 0,
    bot_degen_count: d.bot_degen_count || 0,
    sniper_count: d.sniper_count || 0,
    entrapment_ratio: d.entrapment_ratio || 0,
    bundler_rate: d.bundler_trader_amount_rate || 0,
    is_wash_trading: d.is_wash_trading || false,
    renounced_mint: d.renounced_mint || false,
    renounced_freeze_account: d.renounced_freeze_account || false,
    cto_flag: d.cto_flag || false,
    has_at_least_one_social: d.has_at_least_one_social || false,
    twitter_username: d.twitter || '',
    website: d.website || '',
    telegram: d.telegram || '',
    hot_level: d.hot_level || 0,
    visiting_count: d.visiting_count || 0,
    bot_degen_rate: d.bot_degen_rate || 0,
    price_change_percent5m: d.price_change_percent5m || 0,
    price_change_percent1h: d.price_change_percent1h || 0,
    created_timestamp: d.created_timestamp || 0,

    // Signal metadata
    _signalType: signalType,
    _signalTimes: signalTimes,
    _activeSignals: Object.keys(signalTimes).map(Number),
    _triggerMc: signal.trigger_mc || 0,
    _ath: signal.ath || 0,
    _signalTimesTotal: signal.signal_times || 0,

    // Source marker
    _source: 'signal',
  };
}

// ═══════════════════════════════════════════════════════════
// SIGNAL ADJUSTMENT (core scoring logic)
// ═══════════════════════════════════════════════════════════

/**
 * Apply signal adjustment to base score
 * @param {object} token - token data
 * @param {number} baseScore - from scoreToken()
 * @param {number[]} activeSignals - array of signal type numbers
 * @param {object} config - signal config
 * @returns {{ rawFinalScore, displayScore, signalMeta }}
 */
function applySignalAdjustment(token, baseScore, activeSignals, config) {
  if (!config) config = getSignalConfig();
  const weights = config.signalWeights || DEFAULT_SIGNAL_CONFIG.signalWeights;
  const hardReject = config.hardRejectSignals || [18];

  // ── Hard reject check ────────────────────────────────
  for (const type of activeSignals) {
    if (hardReject.includes(type)) {
      return {
        rawFinalScore: 0,
        displayScore: 0,
        signalMeta: {
          rawSignalScore: 0,
          appliedSignal: 0,
          penalty: 0,
          activeSignals,
          antiDoubleCount: {},
          hardReject: true,
          hardRejectType: type,
          maxContribution: 0,
          rawFinalScore: 0,
          displayScore: 0,
        },
      };
    }
  }

  // ── Layer 1: Calculate signal score ──────────────────
  let signalScore = 0;
  let penalty = 0;
  const antiDoubleCount = {};
  const antiDcEnabled = config.antiDoubleCount?.enabled !== false;
  const antiDcFactor = config.antiDoubleCount?.factor || 0.5;

  for (const type of activeSignals) {
    const weight = weights[type] || 0;
    if (weight === 0) continue;

    let adjustedWeight = weight;

    // Anti-double-counting
    if (antiDcEnabled && weight > 0) {
      let alreadyCounted = false;
      // Type 6 (Smart Money Buy) vs smart_degen_count
      if (type === 6 && (token.smart_degen_count || 0) > 0) {
        alreadyCounted = true;
      }
      // Type 3 (Volume Spike) vs volume_24h — only if volume already significant
      if (type === 3 && (token.volume_24h || token.volume || 0) > 10000) {
        alreadyCounted = true;
      }
      // Type 1 (Price Spike) vs 5m change — only if significant movement
      if (type === 1 && Math.abs(token.price_change_percent5m || 0) > 5) {
        alreadyCounted = true;
      }
      // Type 11 (Holder Surge) vs holder_count — only if holders already substantial
      if (type === 11 && (token.holder_count || 0) > 100) {
        alreadyCounted = true;
      }

      if (alreadyCounted) {
        const reduction = weight * antiDcFactor;
        adjustedWeight = weight - reduction;
        antiDoubleCount[`type${type}`] = reduction;
      }
    }

    if (adjustedWeight > 0) {
      signalScore += adjustedWeight;
    } else {
      penalty += Math.abs(adjustedWeight);
    }
  }

  // ── Layer 2: Dynamic Cap ─────────────────────────────
  const signalRatio = config.signalRatio || 0.30;
  const minContrib = config.minContribution || 10;
  const maxContrib = config.maxContribution || 25;

  const maxSignalContribution = Math.min(
    maxContrib,
    Math.max(minContrib, baseScore * signalRatio)
  );

  const appliedSignal = Math.min(
    Math.max(0, signalScore),
    maxSignalContribution
  );

  // ── Layer 3: Final scores ────────────────────────────
  const rawFinalScore = baseScore + appliedSignal - penalty;
  const displayScore = Math.min(100, Math.max(0, rawFinalScore));

  return {
    rawFinalScore,
    displayScore,
    signalMeta: {
      rawSignalScore: signalScore,
      appliedSignal: parseFloat(appliedSignal.toFixed(1)),
      penalty,
      activeSignals,
      antiDoubleCount,
      hardReject: false,
      maxContribution: parseFloat(maxSignalContribution.toFixed(1)),
      rawFinalScore: parseFloat(rawFinalScore.toFixed(1)),
      displayScore,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// SIGNAL SCAN LOOP
// ═══════════════════════════════════════════════════════════

let signalScanRunning = false;

/**
 * Run one signal scan cycle
 * @param {function} processToken - callback(token) to feed into shared pipeline
 */
async function runSignalScan(processToken) {
  if (signalScanRunning) return;
  signalScanRunning = true;

  try {
    const config = getSignalConfig();
    if (!config.enabled) return;

    console.log(`[SIGNAL] Scanning...`);

    // Fetch signals
    const signals = fetchSignals();
    if (!signals.length) {
      console.log(`[SIGNAL] No signals found`);
      return;
    }

    console.log(`[SIGNAL] Got ${signals.length} signals`);

    // Load per-source seen
    const seen = loadSignalSeen();
    let processed = 0;
    let skippedDedup = 0;
    let skippedGlobal = 0;

    for (const signal of signals) {
      const token = parseSignalToken(signal);
      const addr = token.address;

      if (!addr) continue;

      // Per-source dedup
      if (seen[addr]) {
        skippedDedup++;
        continue;
      }

      // Global dedup
      const globalEntry = checkGlobalDedup(addr);
      if (globalEntry) {
        skippedGlobal++;
        const ageSec = Math.round((Date.now() - globalEntry.firstSeen) / 1000);
        console.log(`[SIGNAL] ${token.symbol} skipped by global dedup (first: ${globalEntry.firstSource}, ${ageSec}s ago)`);
        continue;
      }

      // Process token through shared pipeline
      try {
        await processToken(token, 'signal');
        processed++;
      } catch (e) {
        console.error(`[SIGNAL] Process ${token.symbol} failed: ${e.message}`);
      }

      // Set seen
      seen[addr] = { ts: Date.now() };
      setGlobalDedup(addr, 'signal');
    }

    saveSignalSeen(seen);
    console.log(`[SIGNAL] Done. processed=${processed} dedup=${skippedDedup} global=${skippedGlobal}`);

  } catch (e) {
    console.error(`[SIGNAL] Scan error: ${e.message}`);
  } finally {
    signalScanRunning = false;
  }
}

module.exports = {
  // Config
  getSignalConfig,
  DEFAULT_SIGNAL_CONFIG,
  DEFAULT_DEDUP_CONFIG,

  // Signal processing
  fetchSignals,
  parseSignalToken,
  applySignalAdjustment,

  // Dedup
  checkGlobalDedup,
  setGlobalDedup,
  cleanupGlobalDedup,
  loadGlobalDedup,

  // Scan loop
  runSignalScan,
};
