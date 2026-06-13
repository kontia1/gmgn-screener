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
const { scoreToken, SIGNAL_NAMES, DEFAULT_FILTERS } = require('./screener');
const { autoBuy, getAutoConfig } = require('./src/autotrade');
const { sendTelegram, fmtMc } = require('./lib/shared');
const { alertButtons } = require('./src/buttons');
const { runTrackerScan, getTrackerConfig } = require('./src/smartmoney-tracker');
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
  function trackerProcessToken(token, source) {
    const cfg = getAutoConfig();
    const filters = getActiveFilters();
    const mc = token.market_cap || token.fdv || 0;
    const now = Math.floor(Date.now() / 1000);
    const ageMin = token.created_timestamp ? (now - token.created_timestamp) / 60 : 0;

    // Apply filters (same as signal scanner)
    if (ageMin > 0 && (ageMin < filters.minAgeMin || ageMin > filters.maxAgeMin)) return;
    if (mc > 0 && (mc < filters.minMC || mc > filters.maxMC)) return;
    if (token.is_wash_trading) return;

    // Score with tracker boost
    const baseScore = scoreToken(token, ageMin).score;
    const trackerCfg = getTrackerConfig()[source];
    const boost = trackerCfg?.boostScore || (source === 'smartmoney' ? 12 : 10);
    const finalScore = Math.min(100, baseScore + boost);
    const minScore = Math.max(35, cfg.minScore || 40);

    if (finalScore < minScore) return;

    token._ageMin = ageMin;
    token._score = finalScore;
    token._boostApplied = boost;
    token._source = source;

    // Format alert
    const sourceLabel = source === 'smartmoney' ? '🧠 SmartMoney' : '👑 KOL';
    const tagStr = (token._walletTags || []).filter(t => t !== 'wash_trader').join(', ');
    const walletInfo = token._walletTwitter
      ? `@${token._walletTwitter}`
      : `${(token._walletAddress || '').slice(0, 8)}...`;

    const lines = [
      `${sourceLabel} Buy: <b>${token.symbol}</b>`,
      ``,
      `💰 Amount: $${(token._totalUsd || token._tradeAmountUsd || 0).toFixed(0)}`,
      `👤 Wallet: ${walletInfo}${tagStr ? ` (${tagStr})` : ''}`,
      token._uniqueWallets > 1 ? `👥 ${token._uniqueWallets} wallets buying` : null,
      ``,
      `📊 Score: ${baseScore} + ${boost} = ${finalScore}`,
      `📈 MC: ${fmtMc(mc)} | Liq: ${fmtMc(token.liquidity || 0)}`,
      ``,
      `🔗 <a href="https://gmgn.ai/sol/token/${token.address}">GMGN</a>`,
    ].filter(Boolean);

    // Send alert + auto-buy (same pipeline as signal scanner)
    sendTelegram(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: alertButtons(token.address),
    }).catch(e => console.error(`[TRACKER/${source}] TG: ${e.message}`));

    // Rate-limited auto-buy (delay to avoid Jupiter 429)
    const buyDelay = Math.random() * 2000 + 1000; // 1-3s random delay
    setTimeout(() => {
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
