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
  watchSec: 30,             // wait N seconds after migration before buying
  maxDropPct: 15,           // skip if price drops > N% during watch period
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
    token.market_cap = parseFloat(price.market_cap) || (parseFloat(price.price) || 0) * (parseFloat(raw.circulating_supply || price.circulating_supply) || 0) || 0;
    token.price_usd = parseFloat(price.price) || 0;
    token.circulating_supply = parseFloat(raw.circulating_supply || price.circulating_supply) || 0;
    token.top_10_holder_rate = stat.top_10_holder_rate || token.top_10_holder_rate || 0;
    token.bundler_rate = stat.top_bundler_trader_percentage || stat.bundler_trader_amount_rate || token.bundler_rate || 0;
    token.creation_timestamp = pool.creation_timestamp || token.creation_timestamp || 0;  // for age filter
    token.entrapment_ratio = stat.top_entrapment_trader_percentage || token.entrapment_ratio || 0;
    token.smart_degen_count = stat.smart_degen_count || token.smart_degen_count || 0;
    token.bot_degen_rate = stat.bot_degen_rate || token.bot_degen_rate || 0;
    token.fresh_wallet_rate = stat.fresh_wallet_rate || token.fresh_wallet_rate || 0;
    token.creator_hold_rate = stat.creator_hold_rate || token.creator_hold_rate || 0;

    // Wallet info for notification display
    const dev = info.dev || {};
    const link = info.link || {};
    token._walletAddress = dev.creator_address || dev.address || token._walletAddress || '';
    token._walletTwitter = link.twitter_username || link.twitter || token._walletTwitter || '';

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
      // Token is NEW in snapshot — store it, don't fire migration event
      // (new_external was catching ALL external exchange tokens including old ones)
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

    // Skip global dedup for migration — migration events are rare and valuable
    // Buy lock in trackerProcessToken prevents duplicate buys from different sources

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

    // Filter: token age — reject old tokens (>60 min = already migrated long ago)
    const creationTs = enriched.creation_timestamp || event.creation_timestamp || 0;
    const ageMin = creationTs > 0 ? (Date.now() / 1000 - creationTs) / 60 : 999999;
    if (ageMin > 60) {
      console.log(`[MIGRATION] ${sym} REJECTED: age=${Math.round(ageMin)}m (>60m = old migration)`);
      continue;
    }

    // Filter: top10 concentration (ALL tokens — high concentration = scam risk)
    if (top10 > 0.50) {
      console.log(`[MIGRATION] ${sym} REJECTED: top10=${(top10 * 100).toFixed(0)}% (>50% = scam risk)`);
      continue;
    }

    // Filter: liquidity sanity check — enriched liq must be > $100
    // (Meteora tokens show $30K in trenches but $8 in token info = different pool = scam)
    if (liq > 0 && liq < 100) {
      console.log(`[MIGRATION] ${sym} REJECTED: liq=$${Math.round(liq)} (<$100 = dead/scam pool)`);
      continue;
    }

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

    // ── Watcher: poll every 5s, buy immediately if price up, skip if dump ──
    if (config.watchSec > 0) {
      const initialPrice = enriched.price_usd || 0;
      const pollInterval = 3; // fixed 3s polling
      const maxPolls = Math.ceil(config.watchSec / pollInterval);
      let approved = false;

      console.log(`[MIGRATION] ${sym}: watching max ${config.watchSec}s, polling every ${pollInterval}s (initial: $${initialPrice})...`);

      for (let poll = 1; poll <= maxPolls; poll++) {
        await new Promise(r => setTimeout(r, pollInterval * 1000));

        try {
          const { stdout: stdout2 } = await execAsync(
            `gmgn-cli token info --chain sol --address ${addr} --raw`,
            { timeout: 10000 }
          );
          const raw2 = JSON.parse(stdout2.replace(/\x00/g, ''));
          const info2 = raw2?.data || raw2 || {};
          const price2 = info2.price || {};
          const currentPrice = parseFloat(price2.price) || 0;

          if (initialPrice > 0 && currentPrice > 0) {
            const changePct = ((currentPrice - initialPrice) / initialPrice) * 100;
            const elapsed = poll * pollInterval;
            console.log(`[MIGRATION] ${sym}: +${elapsed}s → $${currentPrice} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`);

            // Price dropped too much → skip
            if (changePct < -config.maxDropPct) {
              console.log(`[MIGRATION] ${sym} REJECTED: price dropped ${Math.abs(changePct).toFixed(1)}% (max ${config.maxDropPct}%) — dump detected`);
              break;
            }

            // Price is up or stable → buy immediately, don't wait full watchSec
            if (changePct >= 0) {
              console.log(`[MIGRATION] ${sym} APPROVED: price ${changePct >= 0 ? 'stable' : 'recovering'} after ${elapsed}s`);
              enriched.price_usd = currentPrice;
              enriched.market_cap = parseFloat(price2.market_cap) || currentPrice * (enriched.circulating_supply || 0);
              approved = true;
              break;
            }

            // Price slightly down but within tolerance → keep watching
            if (poll === maxPolls) {
              // Max wait reached, price still slightly down but within tolerance → approve
              console.log(`[MIGRATION] ${sym} APPROVED: max watch reached, drop ${Math.abs(changePct).toFixed(1)}% within tolerance`);
              enriched.price_usd = currentPrice;
              enriched.market_cap = parseFloat(price2.market_cap) || currentPrice * (enriched.circulating_supply || 0);
              approved = true;
            }
          }
        } catch (watchErr) {
          console.log(`[MIGRATION] ${sym}: watch poll ${poll} failed (${watchErr.message?.slice(0, 50)})`);
          if (poll === maxPolls) approved = true; // proceed on last poll failure
        }
      }

      if (!approved) {
        console.log(`[MIGRATION] ${sym}: watcher rejected (dump detected)`);
        continue;
      }
    }

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
