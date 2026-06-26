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
let newExternalSeen = new Set(); // track addresses already flagged as new_external (per session)

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
  const startTime = Date.now();

  // Source 1: GMGN Trending (50 tokens)
  try {
    const t0 = Date.now();
    const { stdout, stderr } = await execAsync(
      'gmgn-cli market trending --chain sol --interval 1h --limit 50 --raw',
      { timeout: 15000 }
    );
    const elapsed = Date.now() - t0;
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (t.address) allTokens.set(t.address, { ...t, _source: 'trending' });
    }
    const rateLimited = (stderr || '').includes('429') || (stderr || '').includes('rate') || (stderr || '').includes('limit');
    console.log(`[MIGRATION] Trending: ${tokens.length} tokens (${elapsed}ms)${rateLimited ? ' ⚠️ RATE LIMITED' : ''}`);
    if (stderr) console.log(`[MIGRATION] Trending stderr: ${stderr.slice(0, 200)}`);
  } catch (e) {
    const isRateLimit = e.message?.includes('429') || e.message?.includes('rate') || e.stderr?.includes('429');
    console.error(`[MIGRATION] Fetch trending failed: ${e.message?.slice(0, 80)}${isRateLimit ? ' ⚠️ RATE LIMITED' : ''}`);
  }

  // Source 2: GMGN Signal (multiple signal types for broader coverage)
  for (const sigType of [1, 3, 4, 6]) { // Price Spike, Volume Spike, Large Buy, SM Buy
    try {
      const t0 = Date.now();
      const { stdout, stderr } = await execAsync(
        `gmgn-cli market signal --chain sol --signal-type ${sigType} --mc-min 5000 --mc-max 500000 --raw`,
        { timeout: 15000 }
      );
      const elapsed = Date.now() - t0;
      const data = JSON.parse(stdout.replace(/\x00/g, ''));
      const tokens = Array.isArray(data) ? data : (data?.data || []);
      let newCount = 0;
      for (const t of tokens) {
        if (t.address && !allTokens.has(t.address)) {
          allTokens.set(t.address, { ...t, _source: `signal_${sigType}` });
          newCount++;
        }
      }
      const rateLimited = (stderr || '').includes('429') || (stderr || '').includes('rate') || (stderr || '').includes('limit');
      console.log(`[MIGRATION] Signal type ${sigType}: ${tokens.length} tokens, ${newCount} new (${elapsed}ms)${rateLimited ? ' ⚠️ RATE LIMITED' : ''}`);
      if (rateLimited && stderr) console.log(`[MIGRATION] Signal ${sigType} stderr: ${stderr.slice(0, 200)}`);
    } catch (e) {
      const isRateLimit = e.message?.includes('429') || e.message?.includes('rate') || e.stderr?.includes('429');
      console.error(`[MIGRATION] Signal type ${sigType} failed: ${e.message?.slice(0, 80)}${isRateLimit ? ' ⚠️ RATE LIMITED' : ''}`);
    }
    // Small delay between signal calls to avoid rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[MIGRATION] After signal: ${allTokens.size} total unique tokens`);

  // Source 3: GMGN Trenches near_completion (almost graduated)
  try {
    const t0 = Date.now();
    const { stdout, stderr } = await execAsync(
      'gmgn-cli market trenches --chain sol --type near_completion --limit 20 --raw',
      { timeout: 15000 }
    );
    const elapsed = Date.now() - t0;
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.new_creation || data?.data?.new_creation || data?.data || [];
    for (const t of tokens) {
      if (t.address && !allTokens.has(t.address)) {
        allTokens.set(t.address, { ...t, _source: 'trenches_near' });
      }
    }
    const rateLimited = (stderr || '').includes('429') || (stderr || '').includes('rate') || (stderr || '').includes('limit');
    console.log(`[MIGRATION] Trenches near_completion: ${tokens.length} tokens (${elapsed}ms)${rateLimited ? ' ⚠️ RATE LIMITED' : ''}`);
    if (stderr) console.log(`[MIGRATION] Trenches near stderr: ${stderr.slice(0, 200)}`);
  } catch (e) {
    const isRateLimit = e.message?.includes('429') || e.message?.includes('rate') || e.stderr?.includes('429');
    console.error(`[MIGRATION] Fetch trenches near failed: ${e.message?.slice(0, 80)}${isRateLimit ? ' ⚠️ RATE LIMITED' : ''}`);
  }

  // Source 4: GMGN Trenches completed (just graduated)
  try {
    const t0 = Date.now();
    const { stdout, stderr } = await execAsync(
      'gmgn-cli market trenches --chain sol --type completed --limit 20 --raw',
      { timeout: 15000 }
    );
    const elapsed = Date.now() - t0;
    const data = JSON.parse(stdout.replace(/\x00/g, ''));
    const tokens = data?.completed || data?.data?.completed || data?.data || [];
    for (const t of tokens) {
      if (t.address && !allTokens.has(t.address)) {
        allTokens.set(t.address, { ...t, _source: 'trenches_completed' });
      }
    }
    const rateLimited = (stderr || '').includes('429') || (stderr || '').includes('rate') || (stderr || '').includes('limit');
    console.log(`[MIGRATION] Trenches completed: ${tokens.length} tokens (${elapsed}ms)${rateLimited ? ' ⚠️ RATE LIMITED' : ''}`);
    if (stderr) console.log(`[MIGRATION] Trenches completed stderr: ${stderr.slice(0, 200)}`);
  } catch (e) {
    const isRateLimit = e.message?.includes('429') || e.message?.includes('rate') || e.stderr?.includes('429');
    console.error(`[MIGRATION] Fetch trenches completed failed: ${e.message?.slice(0, 80)}${isRateLimit ? ' ⚠️ RATE LIMITED' : ''}`);
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`[MIGRATION] Total: ${allTokens.size} unique tokens in ${totalElapsed}ms`);
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
    token.holder_count = stat.holder_count || price.holder_count || token.holder_count || 0;  // stat first (Meteora tokens)
    token.exchange = pool.exchange || token.exchange || '';
    token.market_cap = parseFloat(price.market_cap) || 0;
    token.price_usd = parseFloat(price.price) || 0;
    token.circulating_supply = parseFloat(price.circulating_supply) || 0;
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
// Tracks TWO signals:
// 1. migrated_pool_exchange: was empty → now has value (GMGN transient field)
// 2. exchange: was 'pump' → now is AMM exchange (more reliable, persists)
const ALL_TARGETS = ['pump_amm', 'meteora_damm_v2', 'meteora_virtual_curve', 'meteora_amm', 'raydium', 'raydium_cpmm'];
const BONDING_EXCHANGES = ['pump', ''];

function detectMigrations(currentTokens, config) {
  const events = [];
  const currentSnapshot = new Map();
  // Merge hardcoded targets with user config
  const targets = new Set([...ALL_TARGETS, ...(config?.targetExchanges || [])]);

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
    if (!prev) {
      // Token is NEW in snapshot. If already on external exchange, treat as migration event
      // (migrated before we first saw it — common for meteora/raydium migrations)
      // Only fire ONCE per address per session (newExternalSeen set)
      if (currentExchange && !BONDING_EXCHANGES.includes(currentExchange) && !['pump_amm'].includes(currentExchange) && !newExternalSeen.has(addr)) {
        newExternalSeen.add(addr);
        events.push({
          ...token,
          migrationEvent: true,
          fromExchange: 'unknown',
          toExchange: currentExchange,
          _detectionMethod: 'new_external',
        });
      }
      continue;
    }

    const prevMpe = prev.migrated_pool_exchange || '';
    const prevExchange = prev.exchange || '';

    // Signal 1: migrated_pool_exchange was empty → now has value
    if (!prevMpe && currentMpe) {
      events.push({
        ...token,
        migrationEvent: true,
        fromExchange: prevMpe || 'bonding_curve',
        toExchange: currentMpe,
        _detectionMethod: 'mpe_field',
      });
      continue; // don't double-count
    }

    // Signal 2: exchange changed from bonding → AMM (more reliable)
    if (BONDING_EXCHANGES.includes(prevExchange) && targets.has(currentExchange)) {
      events.push({
        ...token,
        migrationEvent: true,
        fromExchange: prevExchange || 'bonding_curve',
        toExchange: currentExchange,
        _detectionMethod: 'exchange_change',
      });
    }
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

  const events = detectMigrations(tokens, config);
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

    // Enrich FIRST — raw trending/signal data has unreliable MC (FDV not circulating)
    const enriched = await enrichToken(event);

    // Use enriched data for all filters
    const mc = enriched.market_cap || (enriched.price_usd || 0) * (enriched.circulating_supply || 0) || 0;
    const liq = enriched.liquidity || 0;
    const bundler = enriched.bundler_rate || event.bundler_rate || 0;
    const top10 = enriched.top_10_holder_rate || event.top_10_holder_rate || 0;
    const holders = enriched.holder_count || 0;
    const isExternal = !['pump', 'pump_amm', ''].includes(enriched.exchange || event.exchange || '');

    // Filter: MC range (skip for external exchange — MC data unreliable for Meteora tokens)
    if (!isExternal && mc > 0 && (mc < config.mcMin || (config.mcMax && mc > config.mcMax))) {
      console.log(`[MIGRATION] ${sym} REJECTED: mc=$${Math.round(mc)} (min=${config.mcMin} max=${config.mcMax})`);
      continue;
    }

    // Filter: bundler
    if (config.maxBundlerRate && bundler > config.maxBundlerRate) {
      console.log(`[MIGRATION] ${sym} REJECTED: bundler=${(bundler * 100).toFixed(0)}% (max=${(config.maxBundlerRate * 100).toFixed(0)}%)`);
      continue;
    }

    // Filter: top10
    if (config.maxTop10HolderRate && top10 > config.maxTop10HolderRate) {
      console.log(`[MIGRATION] ${sym} REJECTED: top10=${(top10 * 100).toFixed(0)}% (max=${(config.maxTop10HolderRate * 100).toFixed(0)}%)`);
      continue;
    }

    // Filter: liquidity
    if (config.minLiquidity && liq < config.minLiquidity) {
      console.log(`[MIGRATION] ${sym} REJECTED: liq=$${Math.round(liq)} (min=${config.minLiquidity})`);
      continue;
    }

    // Filter: holders
    if (config.minHolder && holders < config.minHolder) {
      console.log(`[MIGRATION] ${sym} REJECTED: holders=${holders} (min=${config.minHolder})`);
      continue;
    }

    // Mark as seen
    seen[seenKey] = Date.now();
    setGlobalDedup(addr, 'migration');
    // Cleanup old entries before saving
    const now = Date.now();
    for (const [k, v] of Object.entries(seen)) {
      if (now - v > seenTtlSec * 1000) delete seen[k];
    }
    saveSeen(seen);

    // Enrich for display
    enriched.source = 'migration';
    enriched._migrationFrom = event.fromExchange;
    enriched._migrationTo = event.toExchange;
    enriched._detectionMethod = event._detectionMethod;
    // External exchange migrations get higher base score (rarer, more alpha)
    enriched._score = isExternal ? 70 : 60;

    const tag = isExternal ? '🔗 EXTERNAL' : '🎯';
    console.log(`[MIGRATION] ${tag} ${sym} ${event.fromExchange} → ${event.toExchange} (${event._detectionMethod}) | MC=$${Math.round(mc)} | Liq=$${Math.round(liq)}`);

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
