#!/usr/bin/env node
/**
 * GMGN Screener — runs periodically, sends alerts
 * Usage: node screener.js
 */
const { gmgn, sendTelegram, fmtPrice, fmtMc } = require('./lib/shared');
const { autoBuy, getAutoConfig } = require('./src/autotrade');
const { alertButtons } = require('./src/buttons');
const { checkGlobalDedup, setGlobalDedup, applySignalAdjustment, getSignalConfig, runSignalScan } = require('./src/signal-scanner');
const fs = require('fs');
const path = require('path');

const SEEN_DIR = path.join(__dirname, 'output');
const getSeenFile = (source) => path.join(SEEN_DIR, `gmgn-seen-${source || 'trending'}.json`);

// Default hard-coded filters (NEVER change)
const DEFAULT_FILTERS = {
  // ── Existing ──
  minAgeMin: 15, maxAgeMin: 120,
  minMC: 20000, maxMC: 500000,
  minVolume: 10000,
  maxBundlerRate: 0.3,
  maxTop10HolderRate: 0.95,
  minBuyRatio: 1.2,
  minHolder: 0,
  // ── Pre-pump signals (stable, fundamental) ──
  minLiquidity: 8000,         // Pool depth — filter pool tipis
  minSmartDegen: 1,           // Smart money presence — binary signal
  maxEntrapment: 0.08,        // Entrapment < 8% — low rug risk
  minSniper: 3,               // Minimum interest — ada yang nonton
  maxSniper: 50,              // Maximum bot war — hindari sniper war
};

function getActiveFilters() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-config.json'), 'utf8'));
    if (cfg.filterMode === 'custom' && cfg.customFilters) {
      return { ...DEFAULT_FILTERS, ...cfg.customFilters, _isCustom: true };
    }
  } catch {}
  return { ...DEFAULT_FILTERS, _isCustom: false };
}

function loadSeen(source) {
  const seenFile = getSeenFile(source);
  try {
    const d = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    const now = Date.now();
    const clean = {};
    for (const [k, v] of Object.entries(d)) if (now - v.ts < 6 * 3600000) clean[k] = v;
    return clean;
  } catch { return {}; }
}

function saveSeen(s, source) {
  const seenFile = getSeenFile(source);
  const dir = path.dirname(seenFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(seenFile, JSON.stringify(s, null, 2));
}

function getAgeMin(t, now) {
  const ts = t.creation_timestamp || t.created_timestamp || t.open_timestamp || 0;
  return ts ? Math.floor((now - ts) / 60) : -1;
}

function hasSocial(t) { return !!(t.twitter_username || t.website || t.telegram || t.has_at_least_one_social); }

function scoreToken(t, ageMin) {
  let score = 0; const r = [];
  const h = t.holder_count || 0;
  if (h >= 500) { score += 15; r.push(`${h} holders`); }
  else if (h >= 200) { score += 12; r.push(`${h} holders`); }
  else if (h >= 100) { score += 8; r.push(`${h} holders`); }
  else { score += 4; r.push(`${h} holders`); }

  const smart = t.smart_degen_count || t.bot_degen_count || 0;
  if (smart >= 5) { score += 15; r.push(`${smart} smart degens`); }
  else if (smart >= 2) { score += 10; r.push(`${smart} smart degens`); }
  else if (smart >= 1) { score += 5; r.push(`${smart} smart degen`); }

  const vol = t.volume_24h || t.volume || 0;
  if (vol >= 200000) { score += 15; r.push(`$${(vol/1e3).toFixed(0)}K vol`); }
  else if (vol >= 50000) { score += 10; r.push(`$${(vol/1e3).toFixed(0)}K vol`); }
  else if (vol >= 10000) { score += 5; r.push(`$${(vol/1e3).toFixed(0)}K vol`); }

  const buys = t.buys_24h || t.buys || 0;
  const sells = t.sells_24h || t.sells || 0;
  if (sells > 0) {
    const ratio = buys / sells;
    if (ratio >= 2.5) { score += 15; r.push(`B/S ${ratio.toFixed(1)}x`); }
    else if (ratio >= 1.8) { score += 10; r.push(`B/S ${ratio.toFixed(1)}x`); }
    else if (ratio >= 1.2) { score += 5; r.push(`B/S ${ratio.toFixed(1)}x`); }
  }

  const bundler = t.bundler_rate || t.bundler_trader_amount_rate || 0;
  if (bundler < 0.1) { score += 5; r.push('low bundler'); }
  if (!t.is_wash_trading) { score += 5; r.push('no wash'); }
  const top10 = t.top_10_holder_rate || 0;
  if (top10 < 0.8) { score += 5; r.push(`top10 ${(top10*100).toFixed(0)}%`); }
  else if (top10 >= 0.9) { score -= 5; r.push(`⚠️ top10 ${(top10*100).toFixed(0)}%`); }

  if (hasSocial(t)) { score += 10; r.push('has socials'); }
  if (t.renounced_mint && t.renounced_freeze_account) { score += 5; r.push('renounced'); }
  if (t.cto_flag) { score += 5; r.push('CTO'); }
  if (ageMin >= 20 && ageMin <= 60) { score += 5; r.push('sweet spot age'); }

  // Pre-pump signal bonuses
  const liq = t.liquidity || 0;
  if (liq >= 20000) { score += 5; r.push(`$${(liq/1000).toFixed(0)}K liq`); }
  else if (liq >= 10000) { score += 3; r.push(`$${(liq/1000).toFixed(0)}K liq`); }

  const entrap = t.entrapment_ratio || 0;
  if (entrap < 0.03) { score += 3; r.push('low entrapment'); }

  const sniper = t.sniper_count || 0;
  if (sniper >= 10 && sniper <= 40) { score += 3; r.push(`${sniper} snipers`); }

  const p5m = t.price_change_percent5m || 0;
  if (p5m >= 5 && p5m <= 30) { score += 3; r.push(`5m +${p5m.toFixed(0)}%`); }

  const p1h = t.price_change_percent1h || 0;
  if (p1h > 0 && p1h < 150) { score += 2; r.push(`1h +${p1h.toFixed(0)}%`); }
  return { score: Math.max(0, score), reasons: r };
}

function formatAlert(t, score, reasons) {
  const mc = t.market_cap || t.fdv || 0;
  const vol = t.volume_24h || t.volume || 0;
  const ageMin = t._ageMin || 0;
  const price = t.price || 0;
  const ageStr = ageMin >= 60 ? `${(ageMin/60).toFixed(1)}h` : `${ageMin}min`;
  const liq = t.liquidity || 0;
  const smartDegen = t.smart_degen_count || 0;
  const sniperCount = t.sniper_count || 0;
  const entrapment = t.entrapment_ratio || 0;
  const hotLevel = t.hot_level || 0;
  const pChange5m = t.price_change_percent5m || 0;
  const pChange1h = t.price_change_percent1h || 0;

  const lines = [
    `🔍 <b>GMGN Screener</b>`,
    ``,
    `<b>${t.symbol}</b>`,
    `<code>${t.address}</code>`,
    ``,
    `💰 <b>Price:</b> ${fmtPrice(price)}`,
    ``,
    `📊 <b>MC:</b> ${fmtMc(mc)}`,
    `📈 <b>Volume:</b> ${fmtMc(vol)}`,
    `💧 <b>Liquidity:</b> ${fmtMc(liq)}`,
    `👥 <b>Holders:</b> ${t.holder_count || 0}`,
    `⏳ <b>Age:</b> ${ageStr}`,
    `🛒 <b>Buys/Sells:</b> ${t.buys||t.buys_24h||0}/${t.sells||t.sells_24h||0}`,
    `📈 <b>5m:</b> ${pChange5m >= 0 ? '+' : ''}${pChange5m.toFixed(1)}% | <b>1h:</b> ${pChange1h >= 0 ? '+' : ''}${pChange1h.toFixed(0)}%`,
    ``,
    `⭐ <b>Score:</b> ${score}/100`,
    ...reasons.map(x => `• ${x}`),
    ``,
    `🛡️ <b>Safety</b>`,
    `Wash Trading: ${t.is_wash_trading ? '⚠️ Yes' : '✅ No'}`,
    `Bundler: ${((t.bundler_rate||t.bundler_trader_amount_rate||0)*100).toFixed(1)}%`,
    `Top 10 Holders: ${((t.top_10_holder_rate||0)*100).toFixed(1)}%`,
    `Entrapment: ${(entrapment*100).toFixed(1)}%`,
    `Dev Status: ${t.creator_token_status || 'unknown'}`,
    ``,
    `🧠 <b>Signals</b>`,
    `Smart Degens: ${smartDegen}`,
    `Snipers: ${sniperCount}`,
    `Hot Level: ${hotLevel}/3`,
    ``,
    `🔗 <a href="https://gmgn.ai/sol/token/${t.address}">GMGN</a>`,
  ];
  if (t.twitter_username && !t.twitter_username.includes('http'))
    lines.push(`🐦 <a href="https://x.com/${t.twitter_username}">Twitter</a>`);
  if (t.website && t.website.startsWith('http'))
    lines.push(`🌐 <a href="${t.website}">Website</a>`);
  return lines.join('\n');
}

async function runScan() {
  const now = Math.floor(Date.now() / 1000);
  const CONFIG = getActiveFilters();
  // Read screenerSource directly from file (getAutoConfig is cached in-memory)
  let source = 'trending';
  try {
    const cfgFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-config.json'), 'utf8'));
    source = cfgFile.screenerSource || 'trending';
  } catch {}
  console.log(`\n[${new Date().toISOString()}] GMGN scan... (mode: ${CONFIG._isCustom ? 'custom' : 'default'}, source: ${source})`);
  const seen = loadSeen(source);

  let all = new Map();

  if (source === 'trenches') {
    // Server-side: loose pre-filter only (real filtering done client-side)
    const maxAge = CONFIG.maxAgeMin || 90;
    const trenchArgs = [
      'market trenches --chain sol',
      '--type new_creation near_completion',
      '--limit 80',
      `--max-created ${maxAge}m`,
      '--min-created 1m',
      '--sort-by holder_count',
    ];
    // Only add server-side filters if custom values are reasonably loose
    if (CONFIG.maxBundlerRate && CONFIG.maxBundlerRate < 0.5) trenchArgs.push(`--max-bundler-rate ${CONFIG.maxBundlerRate}`);
    if (CONFIG.maxEntrapment != null && CONFIG.maxEntrapment < 0.15) trenchArgs.push(`--max-entrapment-ratio ${CONFIG.maxEntrapment}`);
    const cmd = trenchArgs.join(' ');
    console.log(`[Trenches] ${cmd}`);
    const trenches = await gmgn(cmd);
    const trenchData = trenches?.data || trenches || {};
    for (const t of (trenchData.new_creation || [])) if (t.address) all.set(t.address, t);
    for (const t of (trenchData.near_completion || [])) if (t.address && !all.has(t.address)) all.set(t.address, t);
  } else {
    // ── TRENDING MODE: existing behavior ──
    const [trending, trending6h] = await Promise.all([
      gmgn('market trending --chain sol --interval 1h'),
      gmgn('market trending --chain sol --interval 6h'),
    ]);
    for (const t of (trending?.data?.rank || [])) if (t.address) all.set(t.address, t);
    for (const t of (trending6h?.data?.rank || [])) if (t.address && !all.has(t.address)) all.set(t.address, t);
  }
  console.log(`[Scan] ${all.size} tokens`);

  let count = 0;
  let stats = { age: 0, mc: 0, vol: 0, wash: 0, bundler: 0, top10: 0, buysell: 0, seen: 0, score: 0, liq: 0, smart: 0, entrap: 0, sniper: 0, momentum: 0, hot: 0, visiting: 0, botdegen: 0 };
  for (const [addr, t] of all) {
    const ageMin = getAgeMin(t, now);
    const mc = t.market_cap || t.fdv || 0;
    const vol = t.volume_24h || t.volume || 0;
    const bundler = t.bundler_rate || t.bundler_trader_amount_rate || 0;
    const top10 = t.top_10_holder_rate || 0;
    const buys = t.buys_24h || t.buys || 0;
    const sells = t.sells_24h || t.sells || 0;
    const bsRatio = sells > 0 ? (buys / sells) : 99;
    const isWash = t.is_wash_trading ? 1 : 0;
    // ── Pre-pump signal fields ──
    const liq = t.liquidity || 0;
    const smartDegen = t.smart_degen_count || 0;
    const entrapment = t.entrapment_ratio || 0;
    const sniperCount = t.sniper_count || 0;
    const hotLevel = t.hot_level || 0;
    const visiting = t.visiting_count || 0;
    const botDegen = t.bot_degen_count || 0;
    const pChange1m = t.price_change_percent1m || 0;
    const pChange5m = t.price_change_percent5m || 0;
    const pChange1h = t.price_change_percent1h || 0;

    // Debug: log every token's raw data
    console.log(`  [D] ${t.symbol || '?'} | age:${ageMin.toFixed(0)}m mc:$${(mc/1000).toFixed(0)}K vol:$${(vol/1000).toFixed(1)}K liq:$${(liq/1000).toFixed(1)}K wash:${isWash} bundler:${(bundler*100).toFixed(0)}% top10:${(top10*100).toFixed(0)}% B/S:${bsRatio.toFixed(1)} smart:${smartDegen} sniper:${sniperCount} entrap:${(entrapment*100).toFixed(1)}% hot:${hotLevel} 5m:${pChange5m.toFixed(1)}% 1h:${pChange1h.toFixed(0)}% seen:${!!seen[addr]}`);

    // ── Existing filters ──
    if (ageMin < CONFIG.minAgeMin || ageMin > CONFIG.maxAgeMin) { stats.age++; continue; }
    // Trenches pre-bond tokens have MC ≈ $0 — skip MC filter, rely on liquidity instead
    if (source !== 'trenches') {
      if (mc < CONFIG.minMC || mc > CONFIG.maxMC) { stats.mc++; continue; }
    }
    if (vol < CONFIG.minVolume) { stats.vol++; continue; }
    if (t.is_wash_trading) { stats.wash++; continue; }
    if (bundler > CONFIG.maxBundlerRate) { stats.bundler++; continue; }
    if (top10 > CONFIG.maxTop10HolderRate) { stats.top10++; continue; }
    const holders = t.holder_count || 0;
    if (CONFIG.minHolder && holders < CONFIG.minHolder) { stats.holder = (stats.holder || 0) + 1; continue; }
    if (sells > 0 && buys / sells < CONFIG.minBuyRatio) { stats.buysell++; continue; }

    // ── Pre-pump default filters ──
    if (liq < (CONFIG.minLiquidity || 0)) { stats.liq++; continue; }
    if (smartDegen < (CONFIG.minSmartDegen || 0)) { stats.smart++; continue; }
    if (entrapment > (CONFIG.maxEntrapment ?? 1)) { stats.entrap++; continue; }
    if (sniperCount < (CONFIG.minSniper || 0)) { stats.sniper++; continue; }
    if (sniperCount > (CONFIG.maxSniper ?? 999)) { stats.sniper++; continue; }

    // ── Custom momentum/heat filters (skip for trenches — pre-bond tokens have 0% price data) ──
    if (CONFIG._isCustom && source !== 'trenches') {
      if (CONFIG.minPriceChange5m != null && pChange5m < CONFIG.minPriceChange5m) { stats.momentum++; continue; }
      if (CONFIG.maxPriceChange5m != null && pChange5m > CONFIG.maxPriceChange5m) { stats.momentum++; continue; }
      if (CONFIG.maxPriceChange1h != null && pChange1h > CONFIG.maxPriceChange1h) { stats.momentum++; continue; }
      if (CONFIG.minHotLevel != null && hotLevel < CONFIG.minHotLevel) { stats.hot++; continue; }
      if (CONFIG.minVisitingCount != null && visiting < CONFIG.minVisitingCount) { stats.visiting++; continue; }
      if (CONFIG.minBotDegen != null && botDegen < CONFIG.minBotDegen) { stats.botdegen++; continue; }
      if (CONFIG.maxBotDegen != null && botDegen > CONFIG.maxBotDegen) { stats.botdegen++; continue; }
    }

    if (seen[addr]) { stats.seen++; continue; }

    // Global dedup check (prevents same token from trending+trenches+signal)
    const globalDedup = checkGlobalDedup(addr);
    if (globalDedup) {
      const ageSec = Math.round((Date.now() - globalDedup.firstSeen) / 1000);
      console.log(`  [DEDUP] ${t.symbol} skipped by global dedup (first: ${globalDedup.firstSource}, ${ageSec}s ago)`);
      stats.seen++;
      continue;
    }

    const { score: baseScore, reasons } = scoreToken(t, ageMin);
    const cfg = getAutoConfig();

    // Signal adjustment (independent of base score)
    let finalScore = baseScore;
    let signalMeta = null;
    const signalCfg = getSignalConfig();
    if (signalCfg.enabled && t._activeSignals) {
      const signalResult = applySignalAdjustment(t, baseScore, t._activeSignals, signalCfg);
      finalScore = signalResult.displayScore;
      signalMeta = signalResult.signalMeta;
      if (signalMeta.hardReject) {
        console.log(`  [SIGNAL] ${t.symbol} HARD REJECTED (type ${signalMeta.hardRejectType})`);
        continue;
      }
      console.log(`  [SIGNAL] ${t.symbol} base:${baseScore} signal:+${signalMeta.appliedSignal} penalty:-${signalMeta.penalty} final:${finalScore}`);
    }

    if (finalScore < Math.max(35, cfg.minScore || 40)) { stats.score++; continue; }

    t._ageMin = ageMin;
    const scoreDisplay = signalMeta ? `${finalScore} (base:${baseScore}+${signalMeta.appliedSignal})` : `${baseScore}`;
    console.log(`  ✅ ${t.symbol} | Score:${scoreDisplay} | MC:${fmtMc(mc)} | Age:${ageMin}min`);

    // For trenches tokens with no price data, fetch from token info API
    if (source === 'trenches' && (!t.price || t.price === 0)) {
      try {
        const { gmgnTokenInfo } = require('./lib/shared');
        const info = await gmgnTokenInfo(addr);
        if (info?.price?.price) {
          t.price = parseFloat(info.price.price) || 0;
          const p5m = parseFloat(info.price.price_5m) || 0;
          const p1h = parseFloat(info.price.price_1h) || 0;
          if (p5m > 0) t.price_change_percent5m = ((t.price - p5m) / p5m * 100);
          if (p1h > 0) t.price_change_percent1h = ((t.price - p1h) / p1h * 100);
          // Also update MC from token info if available
          const supply = parseFloat(info.circulating_supply || info.total_supply || 0);
          if (supply > 0 && !t.market_cap) t.market_cap = t.price * supply;
          console.log(`  [INFO] ${t.symbol} price enriched: $${t.price} | 5m: ${t.price_change_percent5m?.toFixed(1)}% | 1h: ${t.price_change_percent1h?.toFixed(0)}%`);
        }
      } catch (e) { console.log(`  [INFO] ${t.symbol} price enrichment failed: ${e.message}`); }
    }

    // Build alert with signal info
    let alertText = formatAlert(t, finalScore, reasons);
    if (signalMeta && signalMeta.appliedSignal > 0) {
      const signalLines = signalMeta.activeSignals
        .filter(type => (signalCfg.signalWeights[type] || 0) > 0)
        .map(type => {
          const weight = signalCfg.signalWeights[type];
          const reduced = signalMeta.antiDoubleCount[`type${type}`] || 0;
          const actual = weight - reduced;
          const name = SIGNAL_NAMES[type] || `Type ${type}`;
          return reduced > 0
            ? `• ${name} (+${actual.toFixed(0)}, reduced from +${weight})`
            : `• ${name} (+${weight})`;
        });
      if (signalLines.length) {
        alertText += `\n\n📡 <b>Signals:</b>\n${signalLines.join('\n')}`;
      }
    }
    try { await sendTelegram(alertText, { reply_markup: alertButtons(addr) }); } catch (e) { console.error(`[TG] Failed: ${e.message}`); }
    // Auto-buy if enabled
    t._score = finalScore;
    t._signalMeta = signalMeta;
    try { await autoBuy(t); } catch (e) { console.error(`[AUTO] ${t.symbol}: ${e.message}`); }

    seen[addr] = {
      ts: Date.now(), score: finalScore, symbol: t.symbol,
      name: t.name || t.symbol, price: t.price || 0,
      mc, vol, holders: t.holder_count || 0, ageMin,
      reasons, phase: 2,
    };
    setGlobalDedup(addr, source);
    count++;
  }

  saveSeen(seen, source);
  console.log(`[Scan] Done. ${count} alerts. Filtered out: age=${stats.age} mc=${stats.mc} vol=${stats.vol} wash=${stats.wash} bundler=${stats.bundler} top10=${stats.top10} holder=${stats.holder||0} buysell=${stats.buysell} liq=${stats.liq} smart=${stats.smart} entrap=${stats.entrap} sniper=${stats.sniper} momentum=${stats.momentum} hot=${stats.hot} visiting=${stats.visiting} botdegen=${stats.botdegen} seen=${stats.seen} score=${stats.score}`);
}

// Run once if executed directly
if (require.main === module) {
  runScan().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

// Signal type names for display
const SIGNAL_NAMES = {
  1: 'Price Spike',
  2: 'Price Dump',
  3: 'Volume Spike',
  4: 'Large Buy',
  5: 'Large Sell',
  6: 'Smart Money Buy',
  7: 'Smart Money Sell',
  8: 'KOL Buy',
  9: 'KOL Sell',
  10: 'New Wallet Influx',
  11: 'Holder Surge',
  12: 'Liquidity Add',
  13: 'Liquidity Remove',
  14: 'Sniper Activity',
  15: 'Multi-Signal',
  16: 'Social Spike',
  17: 'Dev Activity',
  18: 'Rug Warning',
};

module.exports = { runScan, loadSeen, getSeenFile, scoreToken, SIGNAL_NAMES, DEFAULT_FILTERS };
