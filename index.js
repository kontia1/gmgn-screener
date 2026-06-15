#!/usr/bin/env node
/**
 * GMGN Screener + Trader — main entry
 * Runs: screener (10min) + bot (/list, /help, /buy, /sell, /pnl) + auto-trade monitor
 * Usage: node index.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runScan } = require('./screener');
const { startBot } = require('./bot');
const { startMonitor } = require('./src/autotrade');
const { runSignalScan, getSignalConfig, applySignalAdjustment, cleanupGlobalDedup } = require('./src/signal-scanner');
const { scoreToken, SIGNAL_NAMES, DEFAULT_FILTERS, getTrackerStatus } = require('./screener');
const { autoBuy, getAutoConfig } = require('./src/autotrade');
const { sendTelegram, fmtMc } = require('./lib/shared');
const { alertButtons } = require('./src/buttons');
const { runTrackerScan, getTrackerConfig } = require('./src/smartmoney-tracker');
const { logDecision } = require('./src/analytics');
let scanning = false;
let signalScanning = false;
let smScanning = false;
let kolScanning = false;

async function main() {
  console.log(`[${new Date().toISOString()}] GMGN Screener + Trader started`);

  let scanIntervalSec = 600; // default 10 min in seconds

  function loadScanInterval() {
    try {
      const cfg = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, 'data', 'auto-config.json'), 'utf8'
      ));
      // Priority: scanIntervalSec > scanIntervalMin (legacy) > default 600s
      if (cfg.scanIntervalSec > 0) {
        scanIntervalSec = cfg.scanIntervalSec;
      } else if (cfg.scanIntervalMin > 0) {
        scanIntervalSec = cfg.scanIntervalMin * 60;
      }
    } catch {}
  }

  // Scan loop with lock to prevent concurrent scans
  async function scanTick() {
    if (scanning) {
      console.log('[Scan] Previous scan still running, skipping');
    } else {
      scanning = true;
      try { await runScan(); }
      catch (e) { console.error('[Scan]', e); }
      finally { scanning = false; }
    }
    loadScanInterval();
    const min = Math.floor(scanIntervalSec / 60);
    const sec = scanIntervalSec % 60;
    console.log(`[Scan] Next scan in ${min > 0 ? min + 'm ' : ''}${sec}s`);
    setTimeout(scanTick, scanIntervalSec * 1000);
  }

  // Run initial scan after 3s
  setTimeout(scanTick, 3000);
  // ─── Signal Scanner Loop (independent) ───────────────
  function getActiveFilters() {
    try {
      const cfgFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-config.json'), 'utf8'));
      if (cfgFile.filterMode === 'custom' && cfgFile.customFilters) {
        return { ...DEFAULT_FILTERS, ...cfgFile.customFilters, _isCustom: true };
      }
    } catch {}
    return { ...DEFAULT_FILTERS, _isCustom: false };
  }

  function formatSignalAlert(t, baseScore, signalResult) {
    const meta = signalResult.signalMeta;
    const mc = t.market_cap || t.fdv || 0;
    const liq = t.liquidity || 0;
    const ageMin = t._ageMin || 0;
    const ageStr = ageMin >= 60 ? `${(ageMin/60).toFixed(1)}h` : `${ageMin.toFixed(0)}min`;
    const lines = [
      `📡 <b>Signal Buy: ${t.symbol}</b>`,
      ``,
      `Base Score: ${baseScore}`,
      `Signal Bonus: +${meta.appliedSignal}`,
      `Final Score: ${signalResult.displayScore}`,
      ``,
      `Signals:`,
    ];
    for (const type of meta.activeSignals) {
      const weight = getSignalConfig().signalWeights[type] || 0;
      if (weight <= 0) continue;
      const reduced = meta.antiDoubleCount[`type${type}`] || 0;
      const name = SIGNAL_NAMES[type] || `Type ${type}`;
      lines.push(reduced > 0
        ? `• ${name} (+${(weight - reduced).toFixed(0)}, reduced from +${weight})`
        : `• ${name} (+${weight})`);
    }
    lines.push(``, `MC: ${fmtMc(mc)} | Liq: ${fmtMc(liq)} | Age: ${ageStr}`);

    // SM/KOL tracker status
    const tracker = getTrackerStatus(t.address);
    if (tracker.sm || tracker.kol) {
      const { getConfidence } = require('./screener');
      lines.push(``, `📡 <b>Tracker</b>`);
      if (tracker.sm) {
        const smConf = getConfidence('sm', tracker.smWallets);
        lines.push(`🧠 SmartMoney: ${smConf} (${tracker.smWallets} wallet${tracker.smWallets > 1 ? 's' : ''})`);
      }
      if (tracker.kol) {
        const kolConf = getConfidence('kol', tracker.kolWallets);
        lines.push(`👑 KOL: ${kolConf} (${tracker.kolWallets} wallet${tracker.kolWallets > 1 ? 's' : ''})`);
      }
    }

    lines.push(``, `🔗 <a href="https://gmgn.ai/sol/token/${t.address}">GMGN</a>`);
    return lines.join('\n');
  }

  async function signalTick() {
    const signalCfg = getSignalConfig();
    if (!signalCfg.enabled) {
      setTimeout(signalTick, 30000);
      return;
    }
    if (signalScanning) {
      console.log('[SIGNAL] Previous scan still running, skipping');
    } else {
      signalScanning = true;
      try {
        await runSignalScan(async (token) => {
          const CONFIG = getActiveFilters();
          const now = Math.floor(Date.now() / 1000);
          const mc = token.market_cap || token.fdv || 0;
          const ageMin = token.created_timestamp ? (now - token.created_timestamp) / 60 : 0;

          // Pre-calculate score for seen entry (even if rejected by filters)
          const { score: earlyScore } = scoreToken(token, ageMin);
          token._score = earlyScore;

          // Same filters as trending/trenches
          if (ageMin < CONFIG.minAgeMin || ageMin > CONFIG.maxAgeMin) return;
          if (mc < CONFIG.minMC || mc > CONFIG.maxMC) return;
          const vol = token.volume_24h || token.volume || 0;
          if (vol < CONFIG.minVolume) return;
          if (token.is_wash_trading) return;
          const bundler = token.bundler_rate || token.bundler_trader_amount_rate || 0;
          if (bundler > CONFIG.maxBundlerRate) return;
          const top10 = token.top_10_holder_rate || 0;
          if (top10 > CONFIG.maxTop10HolderRate) return;

          const { score: baseScore, reasons } = scoreToken(token, ageMin);
          const signalResult = applySignalAdjustment(token, baseScore, token._activeSignals || [], signalCfg);
          if (signalResult.signalMeta.hardReject) return;
          const cfg = getAutoConfig();
          if (signalResult.displayScore < Math.max(35, cfg.minScore || 40)) return;

          token._ageMin = ageMin;
          token._score = signalResult.displayScore;
          token._signalMeta = signalResult.signalMeta;

          const alertText = formatSignalAlert(token, baseScore, signalResult);
          try { await sendTelegram(alertText, { reply_markup: alertButtons(token.address) }); } catch (e) { console.error(`[SIGNAL] TG: ${e.message}`); }
          logDecision({ token: token.symbol, address: token.address, source: 'signal', baseScore, minScore: Math.max(35, cfg.minScore || 40), confidence: '', wallets: 0, decision: 'buy', reason: 'signal_buy', price: token.price || 0, mc, ageMin });
          try { await autoBuy(token); } catch (e) { console.error(`[SIGNAL] Buy: ${e.message}`); }
        });
      } catch (e) { console.error('[SIGNAL]', e); }
      finally { signalScanning = false; }
    }
    setTimeout(signalTick, (signalCfg.intervalSec || 30) * 1000);
  }

  setTimeout(signalTick, 5000);
  setInterval(cleanupGlobalDedup, 5 * 60 * 1000);

  // ─── SmartMoney + KOL Tracker Loops (independent) ──────
  // ─── Confidence Calculator ─────────────────────────────
  function getConfidence(source, wallets) {
    if (source === 'smartmoney') {
      if (wallets >= 4) return 'High';
      if (wallets >= 2) return 'Medium';
      return 'Low';
    } else {
      if (wallets >= 3) return 'High';
      if (wallets >= 2) return 'Medium';
      return 'Low';
    }
  }

  // ─── SmartMoney + KOL Tracker Processor ────────────────
  function trackerProcessToken(token, source) {
    const cfg = getAutoConfig();
    const filters = getActiveFilters();
    const mc = token.market_cap || token.fdv || 0;
    const now = Math.floor(Date.now() / 1000);
    const ageMin = token.created_timestamp ? (now - token.created_timestamp) / 60 : 0;

    // Pre-calculate score for seen entry (even if rejected by filters)
    // Apply filters (same as trending/signal)
    if (ageMin > 0 && (ageMin < filters.minAgeMin || ageMin > filters.maxAgeMin)) return;
    if (mc > 0 && (mc < filters.minMC || mc > filters.maxMC)) return;
    if (token.is_wash_trading) return;
    const vol = token.volume_24h || token.volume || 0;
    if (vol > 0 && vol < (filters.minVolume || 0)) return;
    const bundler = token.bundler_rate || 0;
    if (bundler > 0 && bundler > (filters.maxBundlerRate || 1)) return;

    // Score — baseScore murni, TANPA boost
    const baseScore = scoreToken(token, ageMin).score;

    // Per-source minScore
    const sourceMinScore = {
      smartmoney: cfg.smartmoneyTracker?.smartmoney?.minScore || 50,
      kol: cfg.kolTracker?.kol?.minScore || 55,
    };
    const minScore = sourceMinScore[source] || cfg.minScore || 50;

    if (baseScore < minScore) {
      console.log(`[TRACKER/${source}] ${token.symbol} rejected: baseScore ${baseScore} < minScore ${minScore}`);
      logDecision({ token: token.symbol, address: token.address, source, baseScore, minScore, confidence: getConfidence(source, token._uniqueWallets || 1), wallets: token._uniqueWallets || 1, decision: 'reject', reason: 'below_minScore', price: token.price || 0, mc, ageMin });
      return;
    }

    // ── Re-check enabled (race condition fix) ──
    const reCheck = getTrackerConfig()[source];
    if (!reCheck?.enabled) {
      console.log(`[TRACKER/${source}] ${token.symbol} skipped — disabled during processing`);
      return;
    }

    token._ageMin = ageMin;
    token._score = baseScore;
    token._source = source;

    // ── Alert Confirmation — check existing position (mode-aware) ──
    const { getOpenPositions, isBuyLocked, getBuyLockRemaining } = require('./src/autotrade');
    const isDry = cfg.mode === 'dry_run';
    const dryRun = require('./src/dry-run');
    const existing = (isDry ? dryRun.getOpenDryPositions() : getOpenPositions()).find(p => p.tokenMint === token.address);

    // ── Confidence calculation ──
    const wallets = token._uniqueWallets || 1;
    const confidence = getConfidence(source, wallets);
    const sourceLabel = source === 'smartmoney' ? '🧠 SmartMoney' : '👑 KOL';

    // ── Buy lock check ──
    if (isBuyLocked(token.address)) {
      const remaining = getBuyLockRemaining(token.address);
      logDecision({ token: token.symbol, address: token.address, source, baseScore, minScore, confidence, wallets, decision: 'skip', reason: 'buy_lock', price: token.price || 0, mc, ageMin });
      const lockLines = [
        `${sourceLabel} Confirmation`,
        ``,
        `<b>${token.symbol}</b>`,
        ``,
        `📊 Score: ${baseScore}`,
        `${sourceLabel}: ${confidence} (${wallets} wallet${wallets > 1 ? 's' : ''})`,
        ``,
        `⚠️ Buy skipped`,
        `Reason: Active Buy Lock (${remaining}s remaining)`,
        ``,
        `Source: ${sourceLabel}`,
        `🔗 <a href="https://gmgn.ai/sol/token/${token.address}">GMGN</a>`,
      ];
      sendTelegram(lockLines.join('\n'), { parse_mode: 'HTML' })
        .catch(e => console.error(`[TRACKER/${source}] TG: ${e.message}`));
      return;
    }

    // ── Existing position check ──
    if (existing) {
      logDecision({ token: token.symbol, address: token.address, source, baseScore, minScore, confidence, wallets, decision: 'skip', reason: 'already_in_position', price: token.price || 0, mc, ageMin });
      const posLines = [
        `${sourceLabel} Confirmation`,
        ``,
        `<b>${token.symbol}</b>`,
        ``,
        `📊 Score: ${baseScore}`,
        `${sourceLabel}: ${confidence} (${wallets} wallet${wallets > 1 ? 's' : ''})`,
        ``,
        `⚠️ Buy skipped`,
        `Reason: Already in Position`,
        ``,
        `Source: ${sourceLabel}`,
        `🔗 <a href="https://gmgn.ai/sol/token/${token.address}">GMGN</a>`,
      ];
      sendTelegram(posLines.join('\n'), { parse_mode: 'HTML' })
        .catch(e => console.error(`[TRACKER/${source}] TG: ${e.message}`));
      return;
    }

    // ── Normal alert + autoBuy ──
    const tagStr = (token._walletTags || []).filter(t => t !== 'wash_trader').join(', ');
    const walletInfo = token._walletTwitter
      ? `@${token._walletTwitter}`
      : `${(token._walletAddress || '').slice(0, 8)}...`;

    const fmtMcLocal = (v) => !v || v <= 0 ? '$0' : `$${Math.round(v).toLocaleString('en-US')}`;

    const lines = [
      `${sourceLabel} Buy: <b>${token.symbol}</b>`,
      ``,
      `📊 Score: ${baseScore}`,
      `${sourceLabel}: ${confidence} (${wallets} wallet${wallets > 1 ? 's' : ''})`,
      `💰 Amount: $${(token._totalUsd || token._tradeAmountUsd || 0).toFixed(0)}`,
      `👤 Wallet: ${walletInfo}${tagStr ? ` (${tagStr})` : ''}`,
      token._uniqueWallets > 1 ? `👥 ${token._uniqueWallets} wallets buying` : null,
      ``,
      `📈 MC: ${fmtMcLocal(mc)} | Liq: ${fmtMcLocal(token.liquidity || 0)}`,
      ``,
      `🔗 <a href="https://gmgn.ai/sol/token/${token.address}">GMGN</a>`,
    ].filter(Boolean);

    sendTelegram(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: alertButtons(token.address),
    }).catch(e => console.error(`[TRACKER/${source}] TG: ${e.message}`));

    // Rate-limited auto-buy
    logDecision({ token: token.symbol, address: token.address, source, baseScore, minScore, confidence, wallets, decision: 'buy', reason: 'auto_buy', price: token.price || 0, mc, ageMin });
    const buyDelay = Math.random() * 2000 + 1000;
    setTimeout(() => {
      // Final re-check before buy
      const finalCheck = getTrackerConfig()[source];
      if (!finalCheck?.enabled) {
        console.log(`[TRACKER/${source}] ${token.symbol} buy cancelled — disabled before execution`);
        return;
      }
      autoBuy(token).catch(e => console.error(`[TRACKER/${source}] Buy: ${e.message}`));
    }, buyDelay);
  }

  function trackerTick(type) {
    const scanningFlag = type === 'smartmoney' ? smScanning : kolScanning;
    const setScanning = (v) => { if (type === 'smartmoney') smScanning = v; else kolScanning = v; };
    const trackerCfg = getTrackerConfig()[type];

    if (!trackerCfg?.enabled) {
      setTimeout(() => trackerTick(type), 30000);
      return;
    }
    if (scanningFlag) {
      console.log(`[TRACKER/${type}] Previous scan still running, skipping`);
    } else {
      setScanning(true);
      runTrackerScan(type, (token) => trackerProcessToken(token, type))
        .catch(e => console.error(`[TRACKER/${type}]`, e))
        .finally(() => setScanning(false));
    }
    setTimeout(() => trackerTick(type), (trackerCfg.intervalSec || 30) * 1000);
  }

  setTimeout(() => trackerTick('smartmoney'), 7000);  // offset from signal scanner
  setTimeout(() => trackerTick('kol'), 9000);          // offset from smartmoney

  // Start auto-trade position monitor
  startMonitor();

  // Start bot polling (runs forever)
  await startBot();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
