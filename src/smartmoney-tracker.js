/**
 * SmartMoney + KOL Tracker — 4th & 5th discovery source
 * Polls gmgn-cli track smartmoney/kol for real-time wallet activity
 * Feeds into shared pipeline: score → alert → autoBuy (live + dry-run)
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { setGlobalDedup, checkGlobalDedup } = require('./signal-scanner');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const SM_SEEN_FILE = path.join(OUTPUT_DIR, 'gmgn-seen-sm.json');
const KOL_SEEN_FILE = path.join(OUTPUT_DIR, 'gmgn-seen-kol.json');

// ─── Default Config ─────────────────────────────────────
const DEFAULT_TRACKER_CONFIG = {
  smartmoney: {
    enabled: true,
    intervalSec: 30,
    minAmountUsd: 10,
    side: 'buy',        // only track buys
    limit: 100,
    boostScore: 12,     // bonus score for smart money buy
  },
  kol: {
    enabled: true,
    intervalSec: 30,
    minAmountUsd: 10,
    side: 'buy',
    limit: 100,
    boostScore: 10,     // bonus score for KOL buy
  },
};

// ─── Load Config ────────────────────────────────────────
function getTrackerConfig() {
  try {
    const cfgFile = path.join(__dirname, '..', 'data', 'auto-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const smRaw = cfg.smartmoneyTracker?.smartmoney || cfg.smartmoneyTracker || {};
    const kolRaw = cfg.kolTracker?.kol || cfg.kolTracker || {};
    return {
      smartmoney: {
        ...DEFAULT_TRACKER_CONFIG.smartmoney,
        ...smRaw,
      },
      kol: {
        ...DEFAULT_TRACKER_CONFIG.kol,
        ...kolRaw,
      },
    };
  } catch {
    return {
      smartmoney: { ...DEFAULT_TRACKER_CONFIG.smartmoney },
      kol: { ...DEFAULT_TRACKER_CONFIG.kol },
    };
  }
}

// ─── Seen Lists (per-source dedup, 6h TTL) ─────────────
function loadSeen(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now = Date.now();
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v.ts < 6 * 3600000) clean[k] = v;
    }
    return clean;
  } catch { return {}; }
}

function saveSeen(filePath, seen) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(seen, null, 2));
}

// ─── Fetch Trade Records ────────────────────────────────
async function fetchTrades(type) {
  const cmd = `gmgn-cli track ${type} --chain sol --limit 100 --raw`;
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(stdout);
    return Array.isArray(data?.list) ? data.list : [];
  } catch (e) {
    console.error(`[TRACKER] ${type} fetch failed: ${e.message}`);
    return [];
  }
}

// ─── Get Token Info (for scoring) ───────────────────────
async function getTokenInfo(tokenAddress) {
  try {
    const cmd = `gmgn-cli token info --chain sol --address ${tokenAddress} --raw`;
    const { stdout } = await execAsync(cmd, { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

// ─── Parse Trade into Screener-Compatible Format ────────
function parseTrade(trade, source) {
  const token = trade.base_token || {};
  const maker = trade.maker_info || {};

  return {
    address: trade.base_address || '',
    symbol: token.symbol || '?',
    name: token.name || '',
    market_cap: 0,   // will be enriched
    fdv: 0,
    price: trade.price_usd || 0,
    price_usd: trade.price_usd || 0,
    liquidity: 0,
    volume_24h: 0,
    volume: 0,
    buys_24h: 0,
    sells_24h: 0,
    buys: 0,
    sells: 0,
    holder_count: 0,
    top_10_holder_rate: 0,
    smart_degen_count: source === 'smartmoney' ? 1 : 0,
    bot_degen_count: 0,
    sniper_count: 0,
    entrapment_ratio: 0,
    bundler_rate: 0,
    is_wash_trading: maker.tags?.includes('wash_trader') || false,
    renounced_mint: false,
    renounced_freeze_account: false,
    cto_flag: false,
    has_at_least_one_social: !!(maker.twitter_username),
    twitter_username: maker.twitter_username || '',
    website: '',
    telegram: '',
    hot_level: 0,
    visiting_count: 0,
    bot_degen_rate: 0,
    price_change_percent5m: 0,
    price_change_percent1h: 0,
    created_timestamp: 0,

    // Trade metadata
    _tradeAmountUsd: trade.amount_usd || 0,
    _tradeSide: trade.side || 'buy',
    _walletAddress: trade.maker || '',
    _walletTags: maker.tags || [],
    _walletTwitter: maker.twitter_username || '',
    _source: source,

    // For scoring compatibility
    _signalType: source === 'smartmoney' ? 6 : 8,  // 6=SmartMoneyBuy, 8=KOLBuy
    _activeSignals: [source === 'smartmoney' ? 6 : 8],
  };
}

// ═══════════════════════════════════════════════════════════
// ENRICHMENT — fetch real token data for scoring
// ═══════════════════════════════════════════════════════════

async function enrichToken(token) {
  const info = await getTokenInfo(token.address);
  if (!info) return token;

  const d = info.data || info;
  const priceData = d.price || {};
  const poolData = d.pool || {};
  const statData = d.stat || {};
  const devData = d.dev || {};
  const linkData = d.link || {};

  // Calculate MC from price * supply
  const priceUsd = parseFloat(priceData.price || 0);
  const supply = parseFloat(d.circulating_supply || d.total_supply || 0);
  token.market_cap = priceUsd * supply;
  token.fdv = priceUsd * parseFloat(d.total_supply || supply);
  token.liquidity = parseFloat(poolData.liquidity || d.liquidity || 0);
  token.volume_24h = parseFloat(priceData.volume_24h || 0);
  token.volume = token.volume_24h;
  token.buys_24h = priceData.buys_24h || 0;
  token.sells_24h = priceData.sells_24h || 0;
  token.buys = priceData.buys_24h || 0;
  token.sells = priceData.sells_24h || 0;
  token.holder_count = d.holder_count || statData.holder_count || 0;
  token.top_10_holder_rate = parseFloat(devData.top_10_holder_rate || statData.top_10_holder_rate || 0);
  token.entrapment_ratio = parseFloat(statData.top_entrapment_trader_percentage || 0);
  token.bundler_rate = parseFloat(statData.top_bundler_trader_percentage || 0);
  token.created_timestamp = d.creation_timestamp || 0;
  token.price_change_percent5m = priceData.price_5m ? ((priceUsd - parseFloat(priceData.price_5m)) / parseFloat(priceData.price_5m) * 100) : 0;
  token.price_change_percent1h = priceData.price_1h ? ((priceUsd - parseFloat(priceData.price_1h)) / parseFloat(priceData.price_1h) * 100) : 0;

  // Enrich socials
  if (linkData.twitter_username) token.twitter_username = linkData.twitter_username;
  if (linkData.website) token.website = linkData.website;
  if (linkData.telegram) token.telegram = linkData.telegram;

  // Enrich flags
  if (devData.cto_flag) token.cto_flag = true;
  if (d.renounced_mint) token.renounced_mint = true;
  if (d.renounced_freeze_account) token.renounced_freeze_account = true;

  // Enrich smart degen / bot degen counts
  const walletStats = d.wallet_tags_stat || {};
  token.smart_degen_count = walletStats.smart_wallets || token.smart_degen_count || 0;
  token.bot_degen_count = statData.bot_degen_count || 0;
  token.sniper_count = walletStats.sniper_wallets || 0;

  return token;
}

// ═══════════════════════════════════════════════════════════
// TRACKER SCAN LOOP
// ═══════════════════════════════════════════════════════════

let smScanRunning = false;
let kolScanRunning = false;

/**
 * Run one tracker scan cycle
 * @param {'smartmoney'|'kol'} type
 * @param {function} processToken - callback(token) to feed into shared pipeline
 */
async function runTrackerScan(type, processToken) {
  const runningFlag = type === 'smartmoney' ? 'smScanRunning' : 'kolScanRunning';
  if (type === 'smartmoney' && smScanRunning) return;
  if (type === 'kol' && kolScanRunning) return;

  if (type === 'smartmoney') smScanRunning = true;
  else kolScanRunning = true;

  try {
    const config = getTrackerConfig()[type];
    if (!config || !config.enabled) return;

    const trades = await fetchTrades(type);
    if (!trades.length) return;

    // Filter: buys only, min amount
    const filtered = trades.filter(t =>
      t.side === 'buy' &&
      (t.amount_usd || 0) >= (config.minAmountUsd || 10) &&
      !t.maker_info?.tags?.includes('wash_trader')
    );

    if (!filtered.length) return;

    console.log(`[TRACKER/${type}] ${filtered.length} qualifying buys from ${trades.length} trades`);

    // Load per-source seen
    const seenFile = type === 'smartmoney' ? SM_SEEN_FILE : KOL_SEEN_FILE;
    const seen = loadSeen(seenFile);
    let processed = 0;
    let skippedDedup = 0;

    // Group by token (aggregate multiple wallets buying same token)
    const tokenGroups = {};
    for (const trade of filtered) {
      const addr = trade.base_address;
      if (!addr) continue;
      if (seen[addr]) { skippedDedup++; continue; }

      // Global dedup (shared with signal scanner)
      if (checkGlobalDedup(addr)) { skippedDedup++; continue; }

      if (!tokenGroups[addr]) {
        tokenGroups[addr] = { trades: [], totalUsd: 0, wallets: new Set() };
      }
      tokenGroups[addr].trades.push(trade);
      tokenGroups[addr].totalUsd += trade.amount_usd || 0;
      tokenGroups[addr].wallets.add(trade.maker);
    }

    // Process each unique token (with rate limiting)
    for (const [addr, group] of Object.entries(tokenGroups)) {
      const representative = group.trades[0];
      const token = parseTrade(representative, type);

      // Enrich with real token data
      await enrichToken(token);

      // Skip tokens with no MC or liquidity after enrichment
      const mc = token.market_cap || token.fdv || 0;
      if (mc <= 0 || (token.liquidity || 0) <= 0) {
        seen[addr] = { ts: Date.now() };
        continue;
      }

      // Add aggregation metadata
      token._tradeCount = group.trades.length;
      token._totalUsd = group.totalUsd;
      token._uniqueWallets = group.wallets.size;

      try {
        // Double-check global dedup right before processing (race condition fix)
        if (checkGlobalDedup(addr)) {
          seen[addr] = { ts: Date.now() };
          saveSeen(seenFile, seen);
          continue;
        }
        await processToken(token);
        processed++;
      } catch (e) {
        console.error(`[TRACKER/${type}] Process ${token.symbol} failed: ${e.message}`);
      }

      seen[addr] = { ts: Date.now() };
      setGlobalDedup(addr, type);  // shared with signal scanner
      saveSeen(seenFile, seen);  // save after each token (persist on restart)
    }

    console.log(`[TRACKER/${type}] Done. processed=${processed} dedup=${skippedDedup}`);

  } catch (e) {
    console.error(`[TRACKER/${type}] Scan error: ${e.message}`);
  } finally {
    if (type === 'smartmoney') smScanRunning = false;
    else kolScanRunning = false;
  }
}

module.exports = {
  getTrackerConfig,
  DEFAULT_TRACKER_CONFIG,
  fetchTrades,
  parseTrade,
  enrichToken,
  runTrackerScan,
};
