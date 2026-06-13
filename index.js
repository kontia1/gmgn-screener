#!/usr/bin/env node
/**
 * GMGN Screener + Trader — main entry
 * Runs: screener (10min) + bot (/list, /help, /buy, /sell, /pnl) + auto-trade monitor
 * Usage: node index.js
 */
require('dotenv').config();
const { runScan } = require('./screener');
const { startBot } = require('./bot');
const { startMonitor } = require('./src/autotrade');

let scanning = false;

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

  // Start auto-trade position monitor
  startMonitor();

  // Start bot polling (runs forever)
  await startBot();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
