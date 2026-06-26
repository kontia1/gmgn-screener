/**
 * Migration Event Tracker — 6th discovery source
 * Detects tokens that JUST migrated from bonding curve to AMM (pump_amm, meteora_damm_v2)
 * Polls GMGN trending, compares migrated_pool_exchange field between snapshots
 * Migration event = field changed from empty/none to any value
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { setGlobalDedup, checkGlobalDedup } = require('./signal-scanner');
const { getAutoConfig } = require('./autotrade');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MIGRATION_SEEN_FILE = path.join(OUTPUT_DIR, 'gmgn-seen-migration.json');

// ─── Default Config ─────────────────────────────────────
const DEFAULT_MIGRATION_CONFIG = {
  enabled: false,           // OFF by default — user enables via /config
  intervalSec: 90,          // poll every 90s (4 sources takes ~10-15s)
  mcMin: 5000,              // min MC $5K
  mcMax: 200000,            // max MC $200K
  minLiquidity: 5000,       // min liquidity $5K
  maxBundlerRate: 0.30,     // max bundler 30%
  maxTop10HolderRate: 0.40, // max top10 40%
  minHolder: 20,            // min holders 20
  minScore: 35,             // min score (lower than other sources — migration is strong signal)
  targetExchanges: ['pump_amm', 'meteora_damm_v2'], // migration targets to detect
};

// ─── State ──────────────────────────────────────────────
let previousSnapshot = new Map(); // address -> { migrated_pool_exchange, exchange, ... }
let migrationScanning = false;

// ─── Helpers ────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(MIGRATION_SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(MIGRATION_SEEN_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSeen(seen) {
  try {
    fs.writeFileSync(MIGRATION_SEEN_FILE, JSON.stringify(seen, null, 2));
  } catch (e) {
    console.error('[MIGRATION] Failed to save seen:', e.message);
  }
}

function getMigrationConfig() {
  try {
    const cfg = getAutoConfig();
    return { ...DEFAULT_MIGRATION_CONFIG, ...(cfg.migrationTracker || {}) };
  } catch {
    return DEFAULT_MIGRATION_CONFIG;
  }
}

// ─── Fetch tokens from multiple GMGN sources ────────────
async function fetchAllSources() {
  const allTokens = new Map(); // address -> token (dedup by address)

  // Source 1: GMGN Trending (50 tokens)
  try {
    const { stdout } = await execAsync(
      'gmgn-cli market trending --chain sol --interval 1h --limit 50 --raw',
      { timeout: 15000 }
    );
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (t.address) allTokens.set(t.address, { ...t, _source: 'trending' });
    }
    console.log(`[MIGRATION] Trending: ${tokens.length} tokens`);
  } catch (e) {
    console.error('[MIGRATION] Fetch trending failed:', e.message?.slice(0, 80));
  }

  // Source 2: GMGN Signal (multiple signal types for broader coverage)
  for (const sigType of [1, 3, 4, 6]) { // Price Spike, Volume Spike, Large Buy, SM Buy
    try {
      const { stdout } = await execAsync(
        `gmgn-cli market signal --chain sol --signal-type ${sigType} --mc-min 5000 --mc-max 500000 --raw`,
        { timeout: 15000 }
      );
      const data = JSON.parse(stdout.replace(/\x00/g, ''));
      const tokens = data?.data || [];
      for (const t of tokens) {
        if (t.address && !allTokens.has(t.address)) {
          allTokens.set(t.address, { ...t, _source: `signal_${sigType}` });
        }
      }
    } catch (e) {
      // Silent fail per signal type
    }
  }
  console.log(`[MIGRATION] After signal: ${allTokens.size} total unique tokens`);

  // Source 3: GMGN Trenches near_completion (almost graduated)
  try {
    const { stdout } = await execAsync(
      'gmgn-cli market trenches --chain sol --type near_completion --limit 20 --raw',
      { timeout: 15000 }
    );
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.new_creation || data?.data?.new_creation || [];
    for (const t of tokens) {
      if (t.address && !allTokens.has(t.address)) {
        allTokens.set(t.address, { ...t, _source: 'trenches_near' });
      }
    }
    console.log(`[MIGRATION] Trenches near_completion: ${tokens.length} tokens`);
  } catch (e) {
    console.error('[MIGRATION] Fetch trenches near failed:', e.message?.slice(0, 80));
  }

  // Source 4: GMGN Trenches completed (just graduated)
  try {
    const { stdout } = await execAsync(
      'gmgn-cli market trenches --chain sol --type completed --limit 20 --raw',
      { timeout: 15000 }
    );
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.new_creation || data?.data?.new_creation || [];
    for (const t of tokens) {
      if (t.address && !allTokens.has(t.address)) {
        allTokens.set(t.address, { ...t, _source: 'trenches_completed' });
      }
    }
    console.log(`[MIGRATION] Trenches completed: ${tokens.length} tokens`);
  } catch (e) {
    console.error('[MIGRATION] Fetch trenches completed failed:', e.message?.slice(0, 80));
  }

  console.log(`[MIGRATION] Total unique tokens from all sources: ${allTokens.size}`);
  return Array.from(allTokens.values());
}

// ─── Enrich token with GMGN token info ──────────────────
async function enrichToken(token) {
  const addr = token.address;
  if (!addr) return token;
  try {
    const { stdout } = await execAsync(
      `gmgn-cli token info --chain sol --address ${addr} --raw`,
      { timeout: 10000 }
    );
    const raw = JSON.parse(stdout.replace(/\x00/g, ''));
    const info = raw?.data || raw || {};

    // Extract nested fields
    const price = info.price || {};
    const pool = info.pool || {};
    const stat = info.stat || {};

    token.volume_24h = parseFloat(price.volume_24h) || token.volume || 0;
    token.liquidity = parseFloat(pool.liquidity) || token.liquidity || 0;
    token.holder_count = price.holder_count || token.holder_count || 0;
    token.top_10_holder_rate = stat.top_10_holder_rate || token.top_10_holder_rate || 0;
    token.bundler_rate = stat.bundler_trader_amount_rate || token.bundler_rate || 0;
    token.entrapment_ratio = stat.top_entrapment_trader_percentage || token.entrapment_ratio || 0;
    token.smart_degen_count = stat.smart_degen_count || token.smart_degen_count || 0;

    return token;
  } catch {
    return token;
  }
}

// ─── Detect Migration Events ────────────────────────────
function detectMigrations(currentTokens) {
  const events = [];
  const currentSnapshot = new Map();

  for (const token of currentTokens) {
    const addr = token.address;
    if (!addr) continue;

    const currentMpe = token.migrated_pool_exchange || '';
    const currentExchange = token.exchange || '';

    // Store in new snapshot
    currentSnapshot.set(addr, {
      migrated_pool_exchange: currentMpe,
      exchange: currentExchange,
      timestamp: Date.now(),
    });

    // Compare with previous snapshot
    const prev = previousSnapshot.get(addr);
    if (prev) {
      const prevMpe = prev.migrated_pool_exchange || '';
      // Migration event: was empty, now has value
      if (!prevMpe && currentMpe) {
        events.push({
          ...token,
          migrationEvent: true,
          fromExchange: prevMpe || 'bonding_curve',
          toExchange: currentMpe,
        });
      }
    }
    // If token is NEW in trending (not in previous snapshot) AND already migrated,
    // it's not a migration event — just a new trending entry
  }

  // Update snapshot
  previousSnapshot = currentSnapshot;
  return events;
}

// ─── Main Scan ──────────────────────────────────────────
async function runMigrationScan(processToken) {
  const config = getMigrationConfig();
  if (!config.enabled) return;

  const tokens = await fetchAllSources();
  if (!tokens.length) return;

  const events = detectMigrations(tokens);
  if (!events.length) return;

  console.log(`[MIGRATION] Detected ${events.length} migration event(s)`);

  const seen = loadSeen();
  const seenTtlSec = 3600; // 1h dedup

  for (const event of events) {
    const addr = event.address;
    const sym = event.symbol || '?';

    // Global dedup
    if (checkGlobalDedup(addr, 'migration')) {
      console.log(`[MIGRATION] ${sym} skipped: global dedup`);
      continue;
    }

    // Per-source dedup
    const seenKey = `migration_${addr}`;
    if (seen[seenKey] && Date.now() - seen[seenKey] < seenTtlSec * 1000) {
      console.log(`[MIGRATION] ${sym} skipped: seen dedup`);
      continue;
    }

    // Filter: MC range
    const mc = event.market_cap || event.fdv || 0;
    if (mc < config.mcMin || (config.mcMax && mc > config.mcMax)) {
      console.log(`[MIGRATION] ${sym} REJECTED: mc=$${Math.round(mc)} (min=${config.mcMin} max=${config.mcMax})`);
      continue;
    }

    // Filter: bundler
    const bundler = event.bundler_rate || 0;
    if (config.maxBundlerRate && bundler > config.maxBundlerRate) {
      console.log(`[MIGRATION] ${sym} REJECTED: bundler=${(bundler * 100).toFixed(0)}% (max=${(config.maxBundlerRate * 100).toFixed(0)}%)`);
      continue;
    }

    // Filter: top10
    const top10 = event.top_10_holder_rate || 0;
    if (config.maxTop10HolderRate && top10 > config.maxTop10HolderRate) {
      console.log(`[MIGRATION] ${sym} REJECTED: top10=${(top10 * 100).toFixed(0)}% (max=${(config.maxTop10HolderRate * 100).toFixed(0)}%)`);
      continue;
    }

    // Enrich with token info (volume, liq, holders from GMGN API)
    const enriched = await enrichToken(event);

    // Filter: liquidity
    const liq = enriched.liquidity || 0;
    if (config.minLiquidity && liq < config.minLiquidity) {
      console.log(`[MIGRATION] ${sym} REJECTED: liq=$${Math.round(liq)} (min=${config.minLiquidity})`);
      continue;
    }

    // Filter: holders
    const holders = enriched.holder_count || 0;
    if (config.minHolder && holders < config.minHolder) {
      console.log(`[MIGRATION] ${sym} REJECTED: holders=${holders} (min=${config.minHolder})`);
      continue;
    }

    // Mark as seen
    seen[seenKey] = Date.now();
    setGlobalDedup(addr, 'migration');
    saveSeen(seen);

    // Enrich for display
    enriched.source = 'migration';
    enriched._migrationFrom = event.fromExchange;
    enriched._migrationTo = event.toExchange;
    enriched._score = 60; // migration events get base score 60 (strong signal)

    console.log(`[MIGRATION] 🎯 ${sym} migrated ${event.fromExchange} → ${event.toExchange} | MC=$${Math.round(mc)} | Liq=$${Math.round(liq)}`);

    // Feed into pipeline
    await processToken(enriched, 'migration');
  }
}

// ─── Export ──────────────────────────────────────────────
module.exports = {
  runMigrationScan,
  getMigrationConfig,
  DEFAULT_MIGRATION_CONFIG,
};
