/**
 * Inline Keyboard — Menu System + Button Handlers
 * Config uses manual input: click button → type value → done
 */
const { tgApi } = require('../lib/shared');
const positions = require('../src/positions');
const dryRun = require('../src/dry-run');
const trading = require('../src/trading');
const wallet = require('../src/wallet');

// ═══════════════════════════════════════════════════════════
// PENDING INPUT TRACKER — for manual config input
// ═══════════════════════════════════════════════════════════

const pendingInputs = new Map(); // chatId → { configKey, label, current }

// ─── Format helpers (shared across all menus) ───────────
function fmtMc(v) {
  if (!v || v <= 0) return '?';
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function fmtVol(v) {
  if (!v || v <= 0) return '$0';
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function isPendingInput(chatId) {
  return pendingInputs.has(chatId);
}

function getPendingInput(chatId) {
  return pendingInputs.get(chatId);
}

function clearPendingInput(chatId) {
  pendingInputs.delete(chatId);
}

// ═══════════════════════════════════════════════════════════
// MENU CONFIG — edit this to change buttons
// ═══════════════════════════════════════════════════════════

const MENU = {
  // Main menu buttons
  main: [
    [{ text: '📊 Positions', callback_data: 'menu_positions' },
     { text: '📈 PNL', callback_data: 'menu_pnl' }],
    [{ text: '⚙️ Config', callback_data: 'menu_config' },
     { text: '💼 Wallet', callback_data: 'menu_wallet' }],
    [{ text: '📋 Screener', callback_data: 'menu_screener' },
     { text: '🔄 Refresh', callback_data: 'menu_refresh' }],
  ],

  // Position action buttons
  position: (mint) => {
    const s = mint.slice(0, 8);
    return [
      [{ text: '💸 25%', callback_data: `sell_25_${s}` },
       { text: '💸 50%', callback_data: `sell_50_${s}` },
       { text: '💸 100%', callback_data: `sell_100_${s}` }],
      [{ text: '🔄 Refresh', callback_data: `refresh_${s}` },
       { text: '📊 GMGN', url: `https://gmgn.ai/sol/token/${mint}` }],
      [{ text: '📋 Positions', callback_data: 'menu_positions' },
       { text: '🏠 Menu', callback_data: 'menu_main' }],
    ];
  },

  // Config buttons — click to input value manually
  config: (cfg) => [
    [{ text: cfg.enabled ? '🟢 Auto-Trade ON' : '🔴 Auto-Trade OFF', callback_data: 'cfg_toggle' }],
    [{ text: cfg.mode === 'dry_run' ? '🟡 Mode: DRY RUN' : '🟢 Mode: LIVE', callback_data: 'cfg_mode_toggle' }],
    [{ text: `🟡 Soft SL: -${cfg.softSlPct || 15}%`, callback_data: 'cfg_input_softSlPct' },
     { text: `⏱ Wait: ${cfg.softSlWaitSec || 30}s`, callback_data: 'cfg_input_softSlWaitSec' }],
    [{ text: `🛑 Hard SL: -${cfg.hardSlPct || cfg.slPct || 40}%`, callback_data: 'cfg_input_hardSlPct' },
     { text: `📉 Trail: ${cfg.trailingDropPct}%`, callback_data: 'cfg_input_trailingDropPct' }],
    [{ text: `🎯 Trigger: +${cfg.trailingTriggerPct || 20}%`, callback_data: 'cfg_input_trailingTriggerPct' }],
    [{ text: `📊 Score: ${cfg.minScore}`, callback_data: 'cfg_input_minScore' },
     { text: `📦 Max: ${cfg.maxOpenPositions}`, callback_data: 'cfg_input_maxOpenPositions' }],
    [{ text: `⏱ Check: ${cfg.checkIntervalSec}s`, callback_data: 'cfg_input_checkIntervalSec' },
     { text: `🔍 Scan: ${cfg.scanIntervalSec || ((cfg.scanIntervalMin || 10) * 60)}s`, callback_data: 'cfg_input_scanIntervalSec' }],
    [{ text: `💰 Buy: ${cfg.buyAmountSol} SOL`, callback_data: 'cfg_input_buyAmountSol' },
     { text: `📈 Slip: ${cfg.slippageBps / 100}%`, callback_data: 'cfg_input_slippageBps' }],
    // Partial sells
    [{ text: '🎯 Partial Sells', callback_data: 'noop' }],
    ...((cfg.partialSells || []).map((s, i) => {
      const n = i + 1;
      if (s.enabled === false) {
        return [
          { text: `❌ Lv${n} OFF`, callback_data: `cfg_part_toggle_${n}` },
          { text: `➕ Enable`, callback_data: `cfg_part_toggle_${n}` },
        ];
      }
      return [
        { text: `✅ Lv${n}`, callback_data: `cfg_part_toggle_${n}` },
        { text: `${s.sellPct}% @ +${s.atPct}%`, callback_data: `cfg_part_edit_${n}` },
      ];
    })),
    // Filter mode
    [{ text: '🔍 Screener Filters', callback_data: 'noop' }],
    [{ text: cfg.filterMode === 'custom' ? '📋 Default' : '✅ Default', callback_data: 'cfg_filter_default' },
     { text: cfg.filterMode === 'custom' ? '✅ Custom' : '🔧 Custom', callback_data: 'cfg_filter_custom' }],
    ...(cfg.filterMode === 'custom' ? [
      [{ text: `⏳ Age: ${cfg.customFilters?.minAgeMin ?? 15}-${cfg.customFilters?.maxAgeMin ?? 120}m`, callback_data: 'cfg_filter_age' },
       { text: `💰 MC: ${fmtMc(cfg.customFilters?.minMC ?? 20000)}-${fmtMc(cfg.customFilters?.maxMC ?? 500000)}`, callback_data: 'cfg_filter_mc' }],
      [{ text: `📊 Vol: ${fmtVol(cfg.customFilters?.minVolume ?? 10000)}+`, callback_data: 'cfg_filter_vol' },
       { text: `💧 Liq: ${fmtVol(cfg.customFilters?.minLiquidity ?? 8000)}+`, callback_data: 'cfg_filter_minLiquidity' }],
      [{ text: `🤝 B/S: ${cfg.customFilters?.minBuyRatio ?? 1.2}x+`, callback_data: 'cfg_filter_buysell' },
       { text: `👤 Holders: ${cfg.customFilters?.minHolder ?? 0}+`, callback_data: 'cfg_filter_minHolder' }],
      [{ text: `🤖 Bundler: <${((cfg.customFilters?.maxBundlerRate ?? 0.3)*100).toFixed(0)}%`, callback_data: 'cfg_filter_bundler' },
       { text: `👥 Top10: <${((cfg.customFilters?.maxTop10HolderRate || 0.95)*100).toFixed(0)}%`, callback_data: 'cfg_filter_top10' }],
      [{ text: `🧠 Smart: ${cfg.customFilters?.minSmartDegen ?? 1}+`, callback_data: 'cfg_filter_minSmartDegen' },
       { text: `🎯 Sniper: ${cfg.customFilters?.minSniper ?? 3}-${cfg.customFilters?.maxSniper ?? 50}`, callback_data: 'cfg_filter_sniper' }],
      [{ text: `🪤 Entrap: <${((cfg.customFilters?.maxEntrapment ?? 0.08)*100).toFixed(0)}%`, callback_data: 'cfg_filter_maxEntrapment' }],
      [{ text: `📈 5m: ${cfg.customFilters?.minPriceChange5m ?? -10}%~${cfg.customFilters?.maxPriceChange5m ?? 35}%`, callback_data: 'cfg_filter_price5m' },
       { text: `📊 1h: <${cfg.customFilters?.maxPriceChange1h ?? 150}%`, callback_data: 'cfg_filter_maxPriceChange1h' }],
      [{ text: `🔥 Hot: ${cfg.customFilters?.minHotLevel ?? 1}+`, callback_data: 'cfg_filter_minHotLevel' },
       { text: `👀 Visits: ${cfg.customFilters?.minVisitingCount ?? 20}+`, callback_data: 'cfg_filter_minVisitingCount' }],
    ] : [
      // Default mode — show active (hard-coded) filters
      [{ text: `⏳ Age: 15-120m`, callback_data: 'noop' },
       { text: `💰 MC: $20K-$500K`, callback_data: 'noop' }],
      [{ text: `📊 Vol: $10K+`, callback_data: 'noop' },
       { text: `💧 Liq: $8K+`, callback_data: 'noop' }],
      [{ text: `🤝 B/S: 1.2x+`, callback_data: 'noop' },
       { text: `🤖 Bundler: <30%`, callback_data: 'noop' }],
    ]),
    // Signal Scanner
    [{ text: '📡 Signal Scanner', callback_data: 'noop' }],
    [{ text: cfg.signalScanner?.enabled !== false ? '✅ Signal ON' : '❌ Signal OFF', callback_data: 'cfg_signal_toggle' },
     { text: '⚙️ Settings', callback_data: 'menu_signal' }],
    [{ text: `⏱ Sig: ${cfg.signalScanner?.intervalSec ?? 30}s`, callback_data: 'cfg_signal_input_intervalSec' },
     { text: `💰 MC: ${fmtMc(cfg.signalScanner?.mcMin ?? 10000)}-${fmtMc(cfg.signalScanner?.mcMax ?? 500000)}`, callback_data: 'cfg_signal_mc' }],
    // Trackers
    [{ text: '📡 Trackers', callback_data: 'noop' }],
    [{ text: `🧠 SM: ${cfg.smartmoneyTracker?.smartmoney?.enabled !== false ? '✅ ON' : '❌ OFF'}`, callback_data: 'tracker_edit_sm' },
     { text: `👑 KOL: ${cfg.kolTracker?.kol?.enabled !== false ? '✅ ON' : '❌ OFF'}`, callback_data: 'tracker_edit_kol' }],
    // Buy Lock
    [{ text: '🔒 Buy Lock', callback_data: 'noop' }],
    [{ text: `${cfg.buyLock?.enabled !== false ? '✅ Lock ON' : '❌ Lock OFF'}`, callback_data: 'cfg_buylock_toggle' },
     { text: `⏱ ${cfg.buyLock?.ttlSec || 300}s`, callback_data: 'cfg_buylock_ttl' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ],

  // Config field labels (for input prompt)
  labels: {
    slPct: { label: 'Stop Loss %', hint: 'e.g. 30', min: 5, max: 90 },
    softSlPct: { label: 'Soft SL %', hint: 'e.g. 15 (trigger warning)', min: 3, max: 50 },
    softSlWaitSec: { label: 'Soft SL Wait (sec)', hint: 'e.g. 30', min: 5, max: 300 },
    hardSlPct: { label: 'Hard SL %', hint: 'e.g. 40 (instant sell)', min: 10, max: 90 },
    trailingDropPct: { label: 'Trailing Drop %', hint: 'e.g. 15', min: 1, max: 50 },
    trailingTriggerPct: { label: 'Trailing Trigger %', hint: 'e.g. 50', min: 5, max: 200 },
    minScore: { label: 'Min Score', hint: 'e.g. 40', min: 10, max: 100 },
    maxOpenPositions: { label: 'Max Positions', hint: 'e.g. 10', min: 1, max: 50 },
    checkIntervalSec: { label: 'Check Interval (sec)', hint: 'e.g. 5', min: 3, max: 60 },
    scanIntervalSec: { label: 'Scan Interval (sec)', hint: 'e.g. 60 (1 min)', min: 10, max: 3600 },
    scanIntervalMin: { label: 'Scan Interval (min)', hint: 'e.g. 10', min: 1, max: 60 },
    buyAmountSol: { label: 'Buy Amount (SOL)', hint: 'e.g. 0.015', min: 0.001, max: 10 },
    slippageBps: { label: 'Slippage (bps)', hint: 'e.g. 500 (=5%)', min: 50, max: 5000 },
  },

  // Partial sell labels (dynamic by level)
  partLabels: {
    atPct: { label: 'Trigger PNL %', hint: 'e.g. 50', min: 1, max: 1000 },
    sellPct: { label: 'Sell %', hint: 'e.g. 25', min: 1, max: 100 },
  },

  // Custom filter labels
  filterLabels: {
    minAgeMin: { label: 'Min Age (min)', hint: 'e.g. 0 = no limit', min: 0, max: 600 },
    maxAgeMin: { label: 'Max Age (min)', hint: 'e.g. 120', min: 5, max: 1440 },
    minMC: { label: 'Min Market Cap ($)', hint: 'e.g. 0 = no limit', min: 0, max: 10000000 },
    maxMC: { label: 'Max Market Cap ($)', hint: 'e.g. 500000', min: 0, max: 100000000 },
    minVolume: { label: 'Min Volume ($)', hint: 'e.g. 0 = no limit', min: 0, max: 1000000 },
    minBuyRatio: { label: 'Min Buy/Sell Ratio', hint: 'e.g. 1.2', min: 0.5, max: 10 },
    maxBundlerRate: { label: 'Max Bundler Rate (%)', hint: 'e.g. 30', min: 0, max: 100 },
    maxTop10HolderRate: { label: 'Max Top10 Holders (%)', hint: 'e.g. 95', min: 10, max: 100 },
    minHolder: { label: 'Min Holders', hint: 'e.g. 50', min: 0, max: 10000 },
    // ── Pre-pump filters ──
    minLiquidity: { label: 'Min Liquidity ($)', hint: 'e.g. 0 = no limit', min: 0, max: 1000000 },
    minSmartDegen: { label: 'Min Smart Degens', hint: 'e.g. 1', min: 0, max: 50 },
    maxEntrapment: { label: 'Max Entrapment (%)', hint: 'e.g. 8', min: 0, max: 100 },
    minSniper: { label: 'Min Sniper Count', hint: 'e.g. 3', min: 0, max: 100 },
    maxSniper: { label: 'Max Sniper Count', hint: 'e.g. 50', min: 5, max: 500 },
    // ── Custom momentum filters ──
    minPriceChange5m: { label: 'Min 5m Change (%)', hint: 'e.g. -10', min: -100, max: 500 },
    maxPriceChange5m: { label: 'Max 5m Change (%)', hint: 'e.g. 35', min: -100, max: 500 },
    maxPriceChange1h: { label: 'Max 1h Change (%)', hint: 'e.g. 150', min: 0, max: 5000 },
    minHotLevel: { label: 'Min Hot Level', hint: 'e.g. 1 (0-3)', min: 0, max: 3 },
    minVisitingCount: { label: 'Min Visiting Count', hint: 'e.g. 20', min: 0, max: 10000 },
    minBotDegen: { label: 'Min Bot Degen Count', hint: 'e.g. 10', min: 0, max: 10000 },
    maxBotDegen: { label: 'Max Bot Degen Count', hint: 'e.g. 300', min: 5, max: 50000 },
  },

  // Signal Scanner labels
  signalLabels: {
    intervalSec: { label: 'Signal Interval (sec)', hint: 'e.g. 30', min: 10, max: 300 },
    mcMin: { label: 'Signal Min MC ($)', hint: 'e.g. 10000', min: 0, max: 10000000 },
    mcMax: { label: 'Signal Max MC ($)', hint: 'e.g. 500000', min: 0, max: 100000000 },
    signalRatio: { label: 'Signal Ratio', hint: 'e.g. 0.30 (30%)', min: 0.05, max: 1.0 },
    minContribution: { label: 'Min Signal Contribution', hint: 'e.g. 10', min: 0, max: 50 },
    maxContribution: { label: 'Max Signal Contribution', hint: 'e.g. 25', min: 5, max: 50 },
    dedupTtlSec: { label: 'Global Dedup TTL (sec)', hint: 'e.g. 300', min: 30, max: 3600 },
  },

  // Signal type names (for weight editor)
  signalNames: {
    1: 'Price Spike', 2: 'Price Dump', 3: 'Volume Spike', 4: 'Large Buy',
    5: 'Large Sell', 6: 'Smart Money Buy', 7: 'Smart Money Sell', 8: 'KOL Buy',
    9: 'KOL Sell', 10: 'New Wallet Influx', 11: 'Holder Surge', 12: 'Liquidity Add',
    13: 'Liquidity Remove', 17: 'Dev Activity', 18: 'Rug Warning (reject)',
  },

  // Screener alert buttons
  alert: (mint) => [
    [{ text: '🛒 Buy 0.015', callback_data: `buy_0.015_${mint.slice(0, 8)}` },
     { text: '🛒 Buy 0.05', callback_data: `buy_0.05_${mint.slice(0, 8)}` }],
    [{ text: '📊 GMGN', url: `https://gmgn.ai/sol/token/${mint}` },
     { text: '📈 Birdeye', url: `https://birdeye.so/token/${mint}?chain=solana` }],
  ],

  // Auto-buy notification buttons
  autoBuy: (mint) => {
    const s = mint.slice(0, 8);
    return [
      [{ text: '📊 Position', callback_data: `refresh_${s}` },
       { text: '💸 Sell All', callback_data: `sell_100_${s}` }],
      [{ text: '💸 Sell 25%', callback_data: `sell_25_${s}` },
       { text: '💸 Sell 50%', callback_data: `sell_50_${s}` }],
    ];
  },
};

// ═══════════════════════════════════════════════════════════
// KEYBOARD BUILDERS
// ═══════════════════════════════════════════════════════════

function mainMenu() {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const source = cfg.screenerSource || 'trending';
  return { inline_keyboard: [
    [{ text: '📊 Positions', callback_data: 'menu_positions' },
     { text: '📈 PNL', callback_data: 'menu_pnl' }],
    [{ text: '⚙️ Config', callback_data: 'menu_config' },
     { text: '💼 Wallet', callback_data: 'menu_wallet' }],
    [{ text: source === 'trenches' ? '📋 Screener ⛏️' : source === 'signal' ? '📋 Screener 📡' : '📋 Screener 🔥', callback_data: 'menu_screener' },
     { text: '🔄 Refresh', callback_data: 'menu_refresh' }],
  ]};
}
function positionButtons(mint) { return { inline_keyboard: MENU.position(mint) }; }
function configButtons(cfg) { return { inline_keyboard: MENU.config(cfg) }; }
function alertButtons(mint) { return { inline_keyboard: MENU.alert(mint) }; }
function autoBuyButtons(mint) { return { inline_keyboard: MENU.autoBuy(mint) }; }

// ═══════════════════════════════════════════════════════════
// CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════

async function handleCallbackQuery(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data;
  const queryId = cq.id;
  const msgId = cq.message?.message_id;

  if (!chatId || !data) return;
  await tgApi('answerCallbackQuery', { callback_query_id: queryId });
  console.log(`[BTN] ${data} from ${chatId}`);

  // ── Menu navigation ──
  if (data === 'menu_main') return sendMainMenu(chatId);
  if (data === 'menu_positions') return sendPositionsMenu(chatId);
  if (data === 'menu_pnl') return sendPnlSummary(chatId);
  if (data === 'menu_config') return sendConfigMenu(chatId);
  if (data === 'menu_wallet') return sendWalletMenu(chatId);
  if (data === 'menu_screener') return sendScreenerMenu(chatId);
  if (data === 'menu_tracker') {
    const { routeCommand } = require('../commands/trade');
    return routeCommand(chatId, '/tracker');
  }

  // ── Screener source switch ──
  if (data === 'screener_source_trending' || data === 'screener_source_trenches' || data === 'screener_source_signal') {
    const { updateAutoConfig } = require('../src/autotrade');
    const newSource = data === 'screener_source_trending' ? 'trending' : data === 'screener_source_signal' ? 'signal' : 'trenches';
    updateAutoConfig({ screenerSource: newSource });
    return sendScreenerMenu(chatId);
  }
  if (data === 'menu_refresh') return sendMainMenu(chatId);

  // ── Tracker Toggle ──
  if (data === 'tracker_toggle_sm' || data === 'tracker_toggle_kol') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const { DEFAULT_TRACKER_CONFIG } = require('../src/smartmoney-tracker');

    const isSm = data === 'tracker_toggle_sm';
    const cfgKey = isSm ? 'smartmoneyTracker' : 'kolTracker';
    const trackerKey = isSm ? 'smartmoney' : 'kol';
    const defaults = isSm ? DEFAULT_TRACKER_CONFIG.smartmoney : DEFAULT_TRACKER_CONFIG.kol;

    const cfg = getAutoConfig();
    if (!cfg[cfgKey]) cfg[cfgKey] = {};
    if (!cfg[cfgKey][trackerKey]) cfg[cfgKey][trackerKey] = { ...defaults };

    const newEnabled = !cfg[cfgKey][trackerKey].enabled;
    updateAutoConfig({ [cfgKey]: { ...cfg[cfgKey], [trackerKey]: { ...cfg[cfgKey][trackerKey], enabled: newEnabled } } });

    // Re-read after save to ensure correct state
    const updated = getAutoConfig();
    const t = updated[cfgKey][trackerKey];
    const icon = isSm ? '🧠' : '👑';
    const label = isSm ? 'SmartMoney' : 'KOL';
    const prefix = isSm ? 'sm' : 'kol';
    const minScoreDefault = isSm ? 50 : 55;

    const lines = [
      `${icon} <b>${label} Settings</b>`,
      ``,
      `Status: ${t.enabled ? '✅ ON' : '❌ OFF'}`,
      `Interval: ${t.intervalSec}s`,
      `Min Amount: $${t.minAmountUsd}`,
      `Min Score: ${t.minScore || minScoreDefault}`,
    ];

    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `${t.enabled ? '🔴 OFF' : '🟢 ON'}`, callback_data: `tracker_toggle_${prefix}` },
           { text: `⏱ ${t.intervalSec}s`, callback_data: `tracker_ask_interval_${prefix}` },
           { text: `💰 $${t.minAmountUsd}`, callback_data: `tracker_ask_amount_${prefix}` }],
          [{ text: `📊 Min Score: ${t.minScore || minScoreDefault}`, callback_data: `tracker_ask_minscore_${prefix}` }],
          [{ text: '⬅️ Config', callback_data: 'menu_config' }],
        ]
      }
    });
    return;
  }

  // ── Tracker Edit Detail ──
  if (data === 'tracker_edit_sm' || data === 'tracker_edit_kol') {
    const { getAutoConfig } = require('../src/autotrade');
    const { DEFAULT_TRACKER_CONFIG } = require('../src/smartmoney-tracker');

    const isSm = data === 'tracker_edit_sm';
    const cfgKey = isSm ? 'smartmoneyTracker' : 'kolTracker';
    const trackerKey = isSm ? 'smartmoney' : 'kol';
    const defaults = isSm ? DEFAULT_TRACKER_CONFIG.smartmoney : DEFAULT_TRACKER_CONFIG.kol;
    const icon = isSm ? '🧠' : '👑';
    const label = isSm ? 'SmartMoney' : 'KOL';
    const prefix = isSm ? 'sm' : 'kol';

    const cfg = getAutoConfig();
    if (!cfg[cfgKey]) cfg[cfgKey] = {};
    if (!cfg[cfgKey][trackerKey]) cfg[cfgKey][trackerKey] = { ...defaults };

    const t = cfg[cfgKey][trackerKey];

    const lines = [
      `${icon} <b>${label} Settings</b>`,
      ``,
      `Status: ${t.enabled ? '✅ ON' : '❌ OFF'}`,
      `Interval: ${t.intervalSec}s`,
      `Min Amount: $${t.minAmountUsd}`,
      `Min Score: ${t.minScore || (isSm ? 50 : 55)}`,
    ];

    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `${t.enabled ? '🔴 OFF' : '🟢 ON'}`, callback_data: `tracker_toggle_${prefix}` },
           { text: `⏱ ${t.intervalSec}s`, callback_data: `tracker_ask_interval_${prefix}` },
           { text: `💰 $${t.minAmountUsd}`, callback_data: `tracker_ask_amount_${prefix}` }],
          [{ text: `📊 Min Score: ${t.minScore || (isSm ? 50 : 55)}`, callback_data: `tracker_ask_minscore_${prefix}` }],
          [{ text: '⬅️ Config', callback_data: 'menu_config' }],
        ]
      }
    });
    return;
  }

  // ── Tracker Ask Value (prompt user to type) ──
  if (data.startsWith('tracker_ask_')) {
    const match = data.match(/^tracker_ask_(interval|amount|minscore)_(sm|kol)$/);
    if (!match) return;
    const [, field, prefix] = match;
    const label = prefix === 'sm' ? 'SmartMoney' : 'KOL';
    const fieldLabels = { interval: 'Interval (detik)', amount: 'Min Amount (USD)', minscore: 'Min Score' };
    const examples = { interval: '30', amount: '10', minscore: '50' };

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `✏️ <b>${label} — ${fieldLabels[field]}</b>\n\nKirim angka baru:\nContoh: <code>${examples[field]}</code>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Cancel', callback_data: `tracker_edit_${prefix}` }],
        ]
      }
    });

    // Set waiting state via pendingInputs
    pendingInputs.set(chatId, {
      type: 'tracker',
      field,
      prefix,
      hint: `Kirim angka untuk ${fieldLabels[field]}`,
      min: field === 'interval' ? 10 : field === 'minscore' ? 10 : 0,
      max: field === 'interval' ? 3600 : field === 'amount' ? 10000 : 100,
    });
    return;
  }

  // ── PNL Reset ──
  if (data === 'pnl_reset_live' || data === 'pnl_reset_dry') {
    const isDry = data === 'pnl_reset_dry';
    const fs = require('fs');
    const path = require('path');
    const file = isDry
      ? path.join(__dirname, '..', 'data', 'dry-run-closed.json')
      : path.join(__dirname, '..', 'data', 'closed.json');
    try {
      fs.writeFileSync(file, '[]');
      const label = isDry ? 'Dry Run' : 'Live';
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>${label} PNL reset</b>\n\nAll closed positions cleared.`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📈 PNL', callback_data: 'menu_pnl' }, { text: '🏠 Menu', callback_data: 'menu_main' }]] }
      });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ Reset failed: ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  // ── Close Rugs ──
  if (data === 'close_rugs') return handleCloseRugs(chatId);
  if (data === 'close_empty_accounts') return handleCloseEmptyAccounts(chatId);

  // ── Sell actions ──
  const sellMatch = data.match(/^sell_(\d+)_(.+)$/);
  if (sellMatch) return handleSellButton(chatId, sellMatch[2], parseInt(sellMatch[1]));

  // ── Buy actions ──
  const buyMatch = data.match(/^buy_([0-9.]+)_(.+)$/);
  if (buyMatch) return handleBuyButton(chatId, buyMatch[2], parseFloat(buyMatch[1]));

  // ── Refresh position ──
  const refreshMatch = data.match(/^refresh_(.+)$/);
  if (refreshMatch) return handleRefreshButton(chatId, refreshMatch[1]);

  // ── Config toggle ──
  if (data === 'cfg_toggle') return cfgToggle(chatId, msgId, queryId);
  if (data === 'cfg_mode_toggle') return cfgModeToggle(chatId, msgId, queryId);

  // ── Config input prompt ──
  const inputMatch = data.match(/^cfg_input_(.+)$/);
  if (inputMatch) return cfgPromptInput(chatId, inputMatch[1]);

  // ── Partial sell toggle ──
  const partToggleMatch = data.match(/^cfg_part_toggle_(\d+)$/);
  if (partToggleMatch) return cfgPartToggle(chatId, parseInt(partToggleMatch[1]));

  // ── Partial sell edit (shows sub-menu: atPct or sellPct) ──
  const partEditMatch = data.match(/^cfg_part_edit_(\d+)$/);
  if (partEditMatch) return cfgPartEditMenu(chatId, parseInt(partEditMatch[1]));

  // ── Partial sell field input ──
  const partFieldMatch = data.match(/^cfg_part_(atPct|sellPct)_(\d+)$/);
  if (partFieldMatch) return cfgPartPromptInput(chatId, partFieldMatch[1], parseInt(partFieldMatch[2]));

  // ── Filter mode ──
  if (data === 'cfg_filter_default') return cfgFilterSetMode(chatId, 'default');
  if (data === 'cfg_filter_custom') return cfgFilterSetMode(chatId, 'custom');

  // ── Custom filter input (age/mc use sub-menu) ──
  if (data === 'cfg_filter_age') return cfgFilterAgeMenu(chatId);
  if (data === 'cfg_filter_mc') return cfgFilterMcMenu(chatId);
  if (data === 'cfg_filter_sniper') return cfgFilterSniperMenu(chatId);
  if (data === 'cfg_filter_price5m') return cfgFilterPrice5mMenu(chatId);
  if (data === 'cfg_filter_bundler') return cfgFilterPromptInput(chatId, 'maxBundlerRate');
  if (data === 'cfg_filter_top10') return cfgFilterPromptInput(chatId, 'maxTop10HolderRate');
  if (data === 'cfg_filter_vol') return cfgFilterPromptInput(chatId, 'minVolume');
  if (data === 'cfg_filter_buysell') return cfgFilterPromptInput(chatId, 'minBuyRatio');

  // ── Custom filter field input ──
  const filterFieldMatch = data.match(/^cfg_filter_(.+)$/);
  if (filterFieldMatch) return cfgFilterPromptInput(chatId, filterFieldMatch[1]);

  // ── Noop (section headers) ──
  if (data === 'noop') return;

  // ── Signal Scanner handlers ──
  if (data === 'menu_signal') return sendSignalMenu(chatId);
  if (data === 'cfg_signal_toggle') return cfgSignalToggle(chatId, msgId, queryId);
  if (data === 'cfg_signal_mc') return cfgSignalMcMenu(chatId);
  if (data === 'cfg_signal_anti_dc') return cfgSignalAntiDcToggle(chatId, msgId, queryId);
  if (data === 'cfg_signal_weights') return cfgSignalWeightsMenu(chatId);
  if (data === 'cfg_signal_weight_edit') return cfgSignalWeightSelectMenu(chatId);
  const sigInputMatch = data.match(/^cfg_signal_input_(.+)$/);
  if (sigInputMatch) return cfgSignalPromptInput(chatId, sigInputMatch[1]);
  const sigWeightMatch = data.match(/^cfg_signal_weight_(\d+)$/);
  if (sigWeightMatch) return cfgSignalWeightPromptInput(chatId, parseInt(sigWeightMatch[1]));
  const sigWeightSetMatch = data.match(/^cfg_signal_wset_(\d+)_(-?\d+)$/);
  if (sigWeightSetMatch) return cfgSignalWeightSet(chatId, parseInt(sigWeightSetMatch[1]), parseInt(sigWeightSetMatch[2]));

  // ── Buy Lock handlers ──
  if (data === 'cfg_buylock_toggle') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const cfg = getAutoConfig();
    const current = cfg.buyLock?.enabled !== false;
    updateAutoConfig({ buyLock: { ...(cfg.buyLock || {}), enabled: !current } });
    return sendConfigMenu(chatId);
  }
  if (data === 'cfg_buylock_ttl') {
    pendingInputs.set(chatId, {
      type: 'config',
      configKey: 'buyLock.ttlSec',
      hint: 'Buy Lock TTL (seconds). Default: 300',
      min: 30,
      max: 3600,
    });
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: '🔒 <b>Buy Lock TTL</b>\n\nKirim detik baru:\nContoh: <code>300</code> (5 menit)\nMin: 30 | Max: 3600',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_config' }]] },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// PENDING INPUT HANDLER — call this from bot.js for text msgs
// ═══════════════════════════════════════════════════════════

async function handlePendingInput(chatId, text) {
  const pending = pendingInputs.get(chatId);
  if (!pending) return false;

  const num = parseFloat(text);
  if (isNaN(num)) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `❌ Invalid number. ${pending.hint}`,
      parse_mode: 'HTML',
    });
    return true;
  }

  // Validate range
  const min = pending.min ?? (MENU.labels[pending.configKey]?.min);
  const max = pending.max ?? (MENU.labels[pending.configKey]?.max);
  if (min != null && max != null && (num < min || num > max)) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `❌ Must be ${min}–${max}. Try again:`,
      parse_mode: 'HTML',
    });
    return true;
  }

  const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');

  if (pending.type === 'partial') {
    // Update partial sell level
    const cfg = getAutoConfig();
    const ps = [...(cfg.partialSells || [])];
    if (ps[pending.level - 1]) {
      ps[pending.level - 1][pending.field] = num;
      updateAutoConfig({ partialSells: ps });
    }
    pendingInputs.delete(chatId);
    await sendConfigMenu(chatId);
    return true;
  }

  // Filter field
  if (pending.type === 'filter') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const cfg = getAutoConfig();
    const filters = { ...(cfg.customFilters || {}) };
    // Rate fields need to be stored as decimal (0.3) but input is percentage (30)
    if (pending.filterKey === 'maxBundlerRate' || pending.filterKey === 'maxTop10HolderRate' || pending.filterKey === 'maxEntrapment') {
      filters[pending.filterKey] = num / 100;
    } else {
      filters[pending.filterKey] = num;
    }
    updateAutoConfig({ customFilters: filters });
    pendingInputs.delete(chatId);
    await sendConfigMenu(chatId);
    return true;
  }

  // Signal Scanner field
  if (pending.type === 'signal') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const cfg = getAutoConfig();
    const key = pending.signalKey;

    // Weight fields: w1, w2, ... w18
    if (key.startsWith('w')) {
      const typeId = parseInt(key.slice(1));
      const w = { ...(cfg.signalScanner?.signalWeights || {}) };
      w[typeId] = num;
      updateAutoConfig({ signalScanner: { ...(cfg.signalScanner || {}), signalWeights: w } });
      pendingInputs.delete(chatId);
      await cfgSignalWeightPromptInput(chatId, typeId);
      return true;
    }

    // Dedup TTL
    if (key === 'dedupTtlSec') {
      updateAutoConfig({ dedup: { ...(cfg.dedup || {}), globalTtlSec: num } });
      pendingInputs.delete(chatId);
      await sendSignalMenu(chatId);
      return true;
    }

    // Other signal scanner fields
    updateAutoConfig({ signalScanner: { ...(cfg.signalScanner || {}), [key]: num } });
    pendingInputs.delete(chatId);
    await sendSignalMenu(chatId);
    return true;
  }

  // Tracker field
  if (pending.type === 'tracker') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const { DEFAULT_TRACKER_CONFIG } = require('../src/smartmoney-tracker');

    const isSm = pending.prefix === 'sm';
    const cfgKey = isSm ? 'smartmoneyTracker' : 'kolTracker';
    const trackerKey = isSm ? 'smartmoney' : 'kol';
    const defaults = isSm ? DEFAULT_TRACKER_CONFIG.smartmoney : DEFAULT_TRACKER_CONFIG.kol;

    const cfg = getAutoConfig();
    if (!cfg[cfgKey]) cfg[cfgKey] = {};
    if (!cfg[cfgKey][trackerKey]) cfg[cfgKey][trackerKey] = { ...defaults };

    const fieldMap = { interval: 'intervalSec', amount: 'minAmountUsd', minscore: 'minScore' };
    updateAutoConfig({ [cfgKey]: { ...cfg[cfgKey], [trackerKey]: { ...cfg[cfgKey][trackerKey], [fieldMap[pending.field]]: num } } });
    pendingInputs.delete(chatId);

    // Re-show tracker edit detail (stay on settings page)
    const editData = isSm ? 'tracker_edit_sm' : 'tracker_edit_kol';
    // Simulate callback by re-triggering the edit handler
    const t = getAutoConfig()[cfgKey][trackerKey];
    const icon = isSm ? '🧠' : '👑';
    const label = isSm ? 'SmartMoney' : 'KOL';
    const prefix = isSm ? 'sm' : 'kol';
    const minScoreDefault = isSm ? 50 : 55;
    const lines = [
      `${icon} <b>${label} Settings</b>`,
      ``,
      `Status: ${t.enabled ? '✅ ON' : '❌ OFF'}`,
      `Interval: ${t.intervalSec}s`,
      `Min Amount: $${t.minAmountUsd}`,
      `Min Score: ${t.minScore || minScoreDefault}`,
    ];
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `${t.enabled ? '🔴 OFF' : '🟢 ON'}`, callback_data: `tracker_toggle_${prefix}` },
           { text: `⏱ ${t.intervalSec}s`, callback_data: `tracker_ask_interval_${prefix}` },
           { text: `💰 $${t.minAmountUsd}`, callback_data: `tracker_ask_amount_${prefix}` }],
          [{ text: `📊 Min Score: ${t.minScore || minScoreDefault}`, callback_data: `tracker_ask_minscore_${prefix}` }],
          [{ text: '⬅️ Config', callback_data: 'menu_config' }],
        ]
      }
    });
    return true;
  }

  // Buy Lock TTL (nested key)
  if (pending.configKey === 'buyLock.ttlSec') {
    const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
    const cfg = getAutoConfig();
    updateAutoConfig({ buyLock: { ...(cfg.buyLock || {}), ttlSec: num } });
    pendingInputs.delete(chatId);
    await sendConfigMenu(chatId);
    return true;
  }

  // Regular config field
  updateAutoConfig({ [pending.configKey]: num });
  pendingInputs.delete(chatId);
  await sendConfigMenu(chatId);
  return true;
}

// ─── Quote helper ──────────────────────────────────────
async function getQuoteSol(mint, remainingTokens, decimals) {
  const { getQuote, SOL_MINT } = require('../src/trading');
  try {
    const rawAmount = Math.floor(remainingTokens * Math.pow(10, decimals));
    const quote = await Promise.race([
      getQuote(mint, SOL_MINT, rawAmount, 500),
      new Promise((_, rej) => setTimeout(() => rej(new Error('quote timeout')), 10000)),
    ]);
    return parseFloat(quote.outAmount) / 1e9;
  } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════
// MENU SENDERS
// ═══════════════════════════════════════════════════════════

async function sendMainMenu(chatId) {
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const isDryMode = cfg.mode === 'dry_run';
  const open = isDryMode ? dryRun.getOpenDryPositions() : positions.getOpenPositions();

  const lines = [
    cfg.mode === 'dry_run' ? `🟡 <b>GMGN Screener — DRY RUN</b>` : `🤖 <b>GMGN Screener + Trader</b>`,
    ``,
    `📊 Positions: ${open.length}/${cfg.maxOpenPositions}`,
    `🤖 Auto-Trade: ${cfg.enabled ? '✅ ON' : '❌ OFF'}`,
    cfg.mode === 'dry_run' ? `🟡 Mode: DRY RUN (no real trades)` : null,
    `💰 Buy: ${cfg.buyAmountSol} SOL | 🟡 Soft SL: -${cfg.softSlPct || 15}%/${cfg.softSlWaitSec || 30}s | 🛑 Hard SL: -${cfg.hardSlPct || cfg.slPct || 40}%`,
    `📉 Trail: ${cfg.trailingDropPct}% | 📊 Score: ${cfg.minScore}`,
    `📡 Source: ${cfg.screenerSource === 'trenches' ? '⛏️ Trenches' : cfg.screenerSource === 'signal' ? '📡 Signal' : '🔥 Trending'}`,
    ``,
    `Select option:`,
  ].filter(Boolean);

  await tgApi('sendMessage', {
    chat_id: chatId, text: lines.join('\n'),
    parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: mainMenu(),
  });
}

async function sendPositionsMenu(chatId) {
 try {
  console.log(`[POS] Starting for ${chatId}`);
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const isDryMode = cfg.mode === 'dry_run';
  const open = isDryMode ? dryRun.getOpenDryPositions() : positions.getOpenPositions();
  console.log(`[POS] ${open.length} open positions`);
  if (!open.length) {
    const emptyMsg = isDryMode ? '📭 No dry run positions.' : '📭 No open positions.';
    await tgApi('sendMessage', { chat_id: chatId, text: emptyMsg, parse_mode: 'HTML', reply_markup: mainMenu() });
    return;
  }

  const { gmgnTokenInfo } = require('../lib/shared');

  for (const pos of open) {
    console.log(`[POS] Processing ${pos.symbol}...`);
    const quoteSolOut = await getQuoteSol(pos.tokenMint, pos.remainingTokens, pos.decimals);
    console.log(`[POS] ${pos.symbol} quote: ${quoteSolOut.toFixed(6)} SOL`);
    const quoteFailed = quoteSolOut === 0 && pos.remainingTokens > 0;

    const totalValueSol = quoteSolOut + (pos.totalSolReceived || 0);
    const pnlSol = totalValueSol - pos.solSpent;
    const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;
    const emoji = pnlSol >= 0 ? '🟢' : '🔴';

    // Track peak (only when quote is valid)
    if (!quoteFailed && pnlPct > (pos.peakPnlPct || 0)) {
      pos.peakPnlPct = pnlPct;
      pos.peakPrice = pos.remainingTokens > 0 ? (quoteSolOut / pos.remainingTokens) : pos.peakPrice;
      if (isDryMode) dryRun.updateDryPosition(pos.tokenMint, { peakPnlPct: pnlPct, peakPrice: pos.peakPrice });
      else positions.updatePosition(pos.tokenMint, { peakPnlPct: pnlPct, peakPrice: pos.peakPrice });
    }

    const { gmgnTokenInfo, gmgnTokenPool } = require('../lib/shared');
    console.log(`[POS] ${pos.symbol} fetching GMGN...`);

    // Fetch live MC + Liq in parallel
    let liveMc = 0, liveLiq = 0;
    try {
      const [info, pool] = await Promise.all([
        gmgnTokenInfo(pos.tokenMint),
        gmgnTokenPool(pos.tokenMint),
      ]);
      console.log(`[POS] ${pos.symbol} GMGN done`);
      const price = parseFloat(info?.price?.price || 0);
      const supply = parseFloat(info?.circulating_supply || info?.total_supply || 0);
      liveMc = price * supply;
      liveLiq = parseFloat(pool?.liquidity || 0);
    } catch (e) { console.log(`[POS] ${pos.symbol} GMGN err: ${e.message}`); }

    // Partial sells info
    const ps = pos.partialSells || [];
    const psDone = ps.filter(s => s.sold).length;
    const psTotal = ps.length;
    const psLine = psTotal > 0 ? `🔸 Partial: ${psDone}/${psTotal} sold` : '';

    // Trailing info
    const trailLine = pos.trailingEnabled ? `📍 Peak: +${(pos.peakPnlPct || 0).toFixed(1)}% | Trail: ${pos.trailingDropPct}%` : '';

    const entryPrice = pos.solSpent / (pos.tokenAmount || 1);
    const currentPrice = (!quoteFailed && pos.remainingTokens > 0) ? (quoteSolOut / pos.remainingTokens) : 0;
    const priceChange = (!quoteFailed && entryPrice > 0) ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;

    const mcLine = pos.mc ? (
      liveMc > 0 ? `📈 MC: ${fmtMc(pos.mc)} → ${fmtMc(liveMc)}` : `📈 MC: ${fmtMc(pos.mc)}`
    ) : (liveMc > 0 ? `📈 MC: ${fmtMc(liveMc)}` : null);
    const liqLine = liveLiq > 0 ? `💧 Liq: ${fmtMc(liveLiq)}` : null;
    const lines = [
      `<b>${pos.symbol}</b>`,
      `<code>${pos.tokenMint}</code>`,
      mcLine,
      liqLine,
      ``,
      `💰 Entry: ${pos.solSpent.toFixed(4)} SOL`,
      quoteFailed
        ? `📈 Now: ⚠️ Quote unavailable`
        : `📈 Now: ${quoteSolOut.toFixed(4)} SOL (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%)`,
      quoteFailed
        ? `🔴 PNL: ⚠️ Quote unavailable`
        : `${emoji} PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      `📦 Remaining: ${pos.remainingTokens.toFixed(2)} tokens`,
      `🟡 Soft SL: -${cfg.softSlPct || 15}%/${cfg.softSlWaitSec || 30}s | 🛑 Hard SL: -${cfg.hardSlPct || cfg.slPct || 40}%`,
      trailLine,
      psLine,
      `💸 Sold: ${(pos.totalSolReceived || 0).toFixed(4)} SOL`,
    ].filter(Boolean);

    console.log(`[POS] ${pos.symbol} sending message (${lines.length} lines)...`);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: positionButtons(pos.tokenMint),
    });
    console.log(`[POS] ${pos.symbol} sent OK`);
  }
 } catch (e) {
    console.error(`[BTN] positions error: ${e.message}`);
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Positions error: ${e.message}`, parse_mode: 'HTML', reply_markup: mainMenu() }).catch(() => {});
 }
}

async function sendPnlSummary(chatId) {
  clearPendingInput(chatId);
  const { routeCommand } = require('../commands/trade');
  await routeCommand(chatId, '/pnl');
}

async function sendConfigMenu(chatId) {
  try {
    const { getAutoConfig } = require('../src/autotrade');
    const cfg = getAutoConfig();
    const ps = cfg.partialSells || [];
    const psLines = ps.map((s, i) => s.enabled === false ? `  ${i+1}. ❌ OFF` : `  ${i+1}. Sell ${s.sellPct}% at +${s.atPct}%`);
    const remaining = 100 - ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);

    const lines = [
      `⚙️ <b>Config</b>`,
      ``,
      `🤖 Auto-Trade: ${cfg.enabled ? '✅ ON' : '❌ OFF'}`,
      `🔄 Mode: ${cfg.mode === 'dry_run' ? '🟡 DRY RUN' : '🟢 LIVE'}`,
      `💰 Buy: ${cfg.buyAmountSol} SOL`,
      `🟡 Soft SL: -${cfg.softSlPct || 15}%/${cfg.softSlWaitSec || 30}s`,
      `🛑 Hard SL: -${cfg.hardSlPct || cfg.slPct || 40}%`,
      `📉 Trail: ${cfg.trailingDropPct}%`,
      `🎯 Trigger: +${cfg.trailingTriggerPct || 20}%`,
      `📊 Score: ${cfg.minScore}`,
      `📦 Max: ${cfg.maxOpenPositions}`,
      `⏱ Check: ${cfg.checkIntervalSec}s`,
      `🔍 Scan: ${cfg.scanIntervalSec || ((cfg.scanIntervalMin || 10) * 60)}s`,
      `📈 Slippage: ${cfg.slippageBps / 100}%`,
      ``,
      `🎯 Partial Sells:`,
      ...psLines,
      `  → ${remaining > 0 ? remaining : 0}% trailing TP/SL`,
      ``,
      `🔍 Screener: ${cfg.filterMode === 'custom' ? 'Custom' : 'Default'} (${cfg.screenerSource === 'trenches' ? '⛏️ Trenches' : cfg.screenerSource === 'signal' ? '📡 Signal' : '🔥 Trending'})`,
      ...(cfg.filterMode === 'custom' ? [
        `  Age: ${cfg.customFilters?.minAgeMin ?? 15}-${cfg.customFilters?.maxAgeMin ?? 120}m`,
        `  MC: ${fmtMc(cfg.customFilters?.minMC ?? 20000)}-${fmtMc(cfg.customFilters?.maxMC ?? 500000)}`,
        `  Vol: ${fmtVol(cfg.customFilters?.minVolume ?? 10000)}+ | Liq: ${fmtVol(cfg.customFilters?.minLiquidity ?? 8000)}+`,
        `  B/S: ${cfg.customFilters?.minBuyRatio ?? 1.2}x+ | Holders: ${cfg.customFilters?.minHolder ?? 0}+`,
        `  Bundler: &lt;${((cfg.customFilters?.maxBundlerRate ?? 0.3)*100).toFixed(0)}% | Top10: &lt;${((cfg.customFilters?.maxTop10HolderRate ?? 0.95)*100).toFixed(0)}%`,
        `  Smart: ${cfg.customFilters?.minSmartDegen ?? 1}+ | Sniper: ${cfg.customFilters?.minSniper ?? 3}-${cfg.customFilters?.maxSniper ?? 50}`,
        `  Entrap: &lt;${((cfg.customFilters?.maxEntrapment ?? 0.08)*100).toFixed(0)}%`,
        `  5m: ${cfg.customFilters?.minPriceChange5m ?? -10}%~${cfg.customFilters?.maxPriceChange5m ?? 35}% | 1h: &lt;${cfg.customFilters?.maxPriceChange1h ?? 150}%`,
        `  Hot: ${cfg.customFilters?.minHotLevel ?? 1}+ | Visits: ${cfg.customFilters?.minVisitingCount ?? 20}+`,
      ] : []),
      ``,
      `📡 Signal: ${cfg.signalScanner?.enabled !== false ? '✅ ON' : '❌ OFF'} | Interval: ${cfg.signalScanner?.intervalSec ?? 30}s | MC: ${fmtMc(cfg.signalScanner?.mcMin ?? 10000)}-${fmtMc(cfg.signalScanner?.mcMax ?? 500000)}`,
      ``,
      `Tap button to edit value:`,
    ];

    const r = await tgApi('sendMessage', {
      chat_id: chatId, text: lines.join('\n'),
      parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: configButtons(cfg),
    });
    if (!r.ok) console.error('[CONFIG] sendMessage failed:', r.description);
  } catch (e) {
    console.error('[CONFIG] Error:', e.message);
  }
}

async function sendWalletMenu(chatId) {
  clearPendingInput(chatId);
  try {
    const kp = wallet.getKeypair();
    const [bal, tokens, allAccounts] = await Promise.all([
      wallet.getSolBalance(),
      wallet.getAllTokenBalances(),
      wallet.getAllTokenAccounts(),
    ]);

    const zeroBalance = allAccounts.filter(t => t.isZero);
    const withBalance = allAccounts.filter(t => !t.isZero);

    const lines = [
      `💼 <b>Wallet</b>`,
      ``,
      `📍 <code>${kp.publicKey.toBase58()}</code>`,
      `💰 SOL: ${bal.toFixed(4)}`,
      ``,
      `🪙 <b>Tokens (${tokens.length}):</b>`,
    ];

    if (tokens.length === 0) {
      lines.push(`  No tokens`);
    } else {
      // Get position symbols for matching
      const openPositions = positions.getOpenPositions();
      const mintToSymbol = {};
      for (const p of openPositions) {
        mintToSymbol[p.tokenMint] = p.symbol;
      }

      // Sort by amount desc, show top 15
      const sorted = tokens.sort((a, b) => b.amount - a.amount).slice(0, 15);

      // Fetch symbols for orphaned tokens (not in positions) in parallel
      const orphaned = sorted.filter(t => !mintToSymbol[t.mint]);
      if (orphaned.length > 0) {
        const { gmgnTokenInfo } = require('../lib/shared');
        const results = await Promise.allSettled(orphaned.map(t => gmgnTokenInfo(t.mint)));
        for (let i = 0; i < orphaned.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value?.symbol) {
            mintToSymbol[orphaned[i].mint] = r.value.symbol;
          }
        }
      }

      for (const t of sorted) {
        const symbol = mintToSymbol[t.mint] || null;
        if (symbol) {
          lines.push(`  • <b>${symbol}</b>: ${t.amount.toFixed(2)}`);
        } else {
          const shortMint = t.mint.slice(0, 6) + '...' + t.mint.slice(-4);
          lines.push(`  • <code>${shortMint}</code>: ${t.amount.toFixed(2)}`);
        }
      }
      if (tokens.length > 15) lines.push(`  ... and ${tokens.length - 15} more`);
    }

    if (zeroBalance.length > 0) {
      lines.push(``);
      lines.push(`🗑️ <b>Empty accounts: ${zeroBalance.length}</b>`);
      lines.push(`  (recoverable rent: ~${(zeroBalance.length * 0.002).toFixed(3)} SOL)`);
    }

    const buttons = [
      [{ text: '💀 Close Rugs', callback_data: 'close_rugs' },
       { text: '🔄 Refresh', callback_data: 'menu_wallet' }],
    ];

    if (zeroBalance.length > 0) {
      buttons.unshift([{ text: `🗑️ Close ${zeroBalance.length} Empty Accounts`, callback_data: 'close_empty_accounts' }]);
    }

    buttons.push([{ text: '🔙 Back', callback_data: 'menu_main' }]);

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML', reply_markup: mainMenu() });
  }
}

// ─── Close Rugs Handler ────────────────────────────────
async function handleCloseRugs(chatId) {
  clearPendingInput(chatId);
  const { getQuote, SOL_MINT, sellAll } = require('../src/trading');
  const wallet = require('../src/wallet');

  // Get ALL wallet tokens + open positions + zero-balance accounts
  const [walletTokens, open, allAccounts] = await Promise.all([
    wallet.getAllTokenBalances(),
    Promise.resolve(positions.getOpenPositions()),
    wallet.getAllTokenAccounts(),
  ]);

  const zeroBalance = allAccounts.filter(t => t.isZero);
  const openMints = new Set(open.map(p => p.tokenMint));
  // Orphaned = in wallet but no open position
  const orphaned = walletTokens.filter(t => !openMints.has(t.mint) && t.amount > 0);

  if (!open.length && !orphaned.length && !zeroBalance.length) {
    return tgApi('sendMessage', { chat_id: chatId, text: '📭 No positions or token balances found.', parse_mode: 'HTML', reply_markup: mainMenu() });
  }

  await tgApi('sendMessage', { chat_id: chatId, text: `🔍 Scanning ${open.length} positions + ${orphaned.length} wallet tokens + ${zeroBalance.length} empty accounts...`, parse_mode: 'HTML' });

  let sold = [];
  let skipped = [];
  let errors = [];

  // 1. Sell orphaned wallet tokens (no position tracking)
  for (const t of orphaned) {
    const shortMint = t.mint.slice(0, 8);
    try {
      // Check if token has any value
      const rawAmount = Math.floor(t.amount * Math.pow(10, t.decimals));
      const quote = await getQuote(t.mint, SOL_MINT, rawAmount, 500);
      const solOut = parseFloat(quote.outAmount) / 1e9;

      if (solOut < 0.0001) {
        skipped.push({ symbol: shortMint, reason: `dust (${solOut.toFixed(6)} SOL)` });
        continue;
      }

      // Sell it
      const result = await sellAll(t.mint, 'default', 500);
      if (result.success) {
        sold.push({ symbol: shortMint, recovered: result.outputSol || solOut, source: 'wallet' });
      } else {
        errors.push({ symbol: shortMint, error: 'sell failed' });
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
        // Dead token — close account to recover rent (~0.002 SOL)
        try {
          const result = await wallet.closeTokenAccount(t.mint);
          sold.push({ symbol: shortMint, recovered: 0.002, source: 'rent recovered' });
        } catch (closeErr) {
          skipped.push({ symbol: shortMint, reason: `dead (close failed: ${closeErr.message.slice(0, 40)})` });
        }
      } else if (msg.includes('No tokens to sell')) {
        skipped.push({ symbol: shortMint, reason: 'zero balance' });
      } else if (msg.includes('429') || msg.includes('Too many')) {
        errors.push({ symbol: shortMint, error: 'rate limited' });
      } else {
        errors.push({ symbol: shortMint, error: msg.slice(0, 60) });
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 2. Check open positions for rugs
  for (const pos of open) {
    const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
    try {
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      const solOut = parseFloat(quote.outAmount) / 1e9;
      const pnlPct = pos.solSpent > 0 ? ((solOut - pos.solSpent) / pos.solSpent * 100) : -100;

      if (pnlPct <= -80) {
        // Rug — sell and close
        try {
          const result = await sellAll(pos.tokenMint, 'default', 500);
          const recovered = result.success ? (result.outputSol || solOut) : 0;
          positions.closePosition(pos.tokenMint, recovered, result.signature || 'none', 'rug_scan');
          sold.push({ symbol: pos.symbol, recovered, source: 'position' });
        } catch {
          positions.closePosition(pos.tokenMint, 0, 'none', 'rug_scan');
          sold.push({ symbol: pos.symbol, recovered: 0, source: 'position (sell failed)' });
        }
      } else {
        skipped.push({ symbol: pos.symbol, reason: `PNL ${pnlPct.toFixed(1)}% (healthy)` });
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
        positions.closePosition(pos.tokenMint, 0, 'none', 'rug_scan_dead');
        sold.push({ symbol: pos.symbol, recovered: 0, source: 'position (dead)' });
      } else {
        errors.push({ symbol: pos.symbol, error: msg.slice(0, 60) });
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. Close zero-balance accounts (recover rent)
  let zeroClosed = 0;
  if (zeroBalance.length > 0) {
    try {
      const result = await wallet.closeZeroBalanceAccounts();
      zeroClosed = result.closed;
      if (zeroClosed > 0) {
        sold.push({ symbol: `${zeroClosed} empty`, recovered: result.recovered, source: 'rent' });
      }
    } catch (e) {
      errors.push({ symbol: 'empty accounts', error: e.message.slice(0, 60) });
    }
  }

  // Build result
  const lines = ['💀 <b>Close Rugs — Results</b>\n'];

  if (sold.length) {
    const totalRecovered = sold.reduce((s, c) => s + c.recovered, 0);
    lines.push(`🔴 <b>Sold/Closed: ${sold.length}</b>`);
    for (const s of sold) {
      lines.push(`  ${s.symbol}: recovered ${s.recovered.toFixed(4)} SOL (${s.source})`);
    }
    lines.push(`  💰 Total recovered: ${totalRecovered.toFixed(4)} SOL\n`);
  }

  if (skipped.length) {
    lines.push(`⏭️ <b>Skipped: ${skipped.length}</b>`);
    for (const s of skipped) {
      lines.push(`  ${s.symbol}: ${s.reason}`);
    }
    lines.push('');
  }

  if (errors.length) {
    lines.push(`⚠️ <b>Errors: ${errors.length}</b>`);
    for (const e of errors) {
      lines.push(`  ${e.symbol}: ${e.error}`);
    }
  }

  if (!sold.length && !errors.length) {
    lines.push('✅ No rugs found! All tokens healthy.');
  }

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '💀 Scan Again', callback_data: 'close_rugs' },
       { text: '💼 Wallet', callback_data: 'menu_wallet' }],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ]},
  });
}

// ─── Close Empty Accounts Handler ──────────────────────
async function handleCloseEmptyAccounts(chatId) {
  clearPendingInput(chatId);
  const wallet = require('../src/wallet');

  await tgApi('sendMessage', { chat_id: chatId, text: '🗑️ Closing empty token accounts...', parse_mode: 'HTML' });

  try {
    const result = await wallet.closeZeroBalanceAccounts();

    const lines = [
      `🗑️ <b>Empty Accounts Closed</b>`,
      ``,
      `✅ Closed: ${result.closed} accounts`,
      `💰 Recovered: ~${result.recovered.toFixed(4)} SOL`,
    ];

    if (result.closed === 0) {
      lines.push(`📭 No empty accounts found.`);
    }

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '💼 Wallet', callback_data: 'menu_wallet' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ]},
    });
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML', reply_markup: mainMenu() });
  }
}

async function sendScreenerMenu(chatId) {
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const source = cfg.screenerSource || 'trending';
  const fs = require('fs');
  const path = require('path');
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'output', `gmgn-seen-${source}.json`), 'utf8')); } catch {}

  const entries = Object.entries(seen).sort((a, b) => b[1].ts - a[1].ts).slice(0, 10);
  const lines = [
    `📋 <b>Screener</b>`,
    ``,
    `📡 Source: <b>${source === 'trenches' ? '⛏️ Trenches (new tokens)' : source === 'signal' ? '📡 Signal (GMGN signals)' : '🔥 Trending (hot tokens)'}</b>`,
    `📊 Tokens scanned: ${Object.keys(seen).length}`,
    ``,
  ];

  if (entries.length) {
    lines.push(`<b>Recent scans:</b>`);
    for (const [addr, d] of entries) {
      const ageMin = Math.floor((Date.now() - d.ts) / 60000);
      lines.push(`<b>${d.symbol}</b> | Score: ${d.score} | ${ageMin}m ago`);
      lines.push(`<code>${addr}</code>\n`);
    }
  } else {
    lines.push(`📭 No screened tokens yet.`);
  }

  const buttons = [
    [
      { text: source === 'trending' ? '🔥 Trending ✅' : '🔥 Trending', callback_data: 'screener_source_trending' },
      { text: source === 'trenches' ? '⛏️ Trenches ✅' : '⛏️ Trenches', callback_data: 'screener_source_trenches' },
    ],
    [
      { text: source === 'signal' ? '📡 Signal ✅' : '📡 Signal', callback_data: 'screener_source_signal' },
    ],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId, text: lines.join('\n'),
    parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
  });
}

// ═══════════════════════════════════════════════════════════
// CONFIG HANDLERS
// ═══════════════════════════════════════════════════════════

async function cfgToggle(chatId, msgId, queryId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  require('../src/autotrade').updateAutoConfig({ enabled: !cfg.enabled });
  const newCfg = getAutoConfig();
  await tgApi('editMessageReplyMarkup', {
    chat_id: chatId, message_id: msgId,
    reply_markup: JSON.stringify(configButtons(newCfg)),
  });
  await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: `Auto-trade ${newCfg.enabled ? 'ON' : 'OFF'}` });
}

async function cfgModeToggle(chatId, msgId, queryId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const newMode = cfg.mode === 'dry_run' ? 'live' : 'dry_run';
  require('../src/autotrade').updateAutoConfig({ mode: newMode });
  const newCfg = getAutoConfig();
  await tgApi('editMessageReplyMarkup', {
    chat_id: chatId, message_id: msgId,
    reply_markup: JSON.stringify(configButtons(newCfg)),
  });
  await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: `Mode: ${newMode === 'dry_run' ? 'DRY RUN' : 'LIVE'}` });
}

async function cfgPromptInput(chatId, configKey) {
  const field = MENU.labels[configKey];
  if (!field) return;

  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const current = cfg[configKey];

  // Store pending input
  pendingInputs.set(chatId, {
    type: 'config',
    configKey,
    label: field.label,
    hint: field.hint,
    current,
  });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>${field.label}</b>\n\nCurrent: <code>${current}</code>\n\nType new value (${field.hint}):`,
    parse_mode: 'HTML',
  });
}

async function cfgPartToggle(chatId, level) {
  const { getAutoConfig, updateAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const ps = [...(cfg.partialSells || [])];
  if (!ps[level - 1]) return;
  ps[level - 1].enabled = ps[level - 1].enabled === false ? true : false;
  updateAutoConfig({ partialSells: ps });
  await sendConfigMenu(chatId);
}

async function cfgPartEditMenu(chatId, level) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const ps = cfg.partialSells || [];
  const s = ps[level - 1];
  if (!s) return;

  const buttons = [
    [{ text: `📊 Sell: ${s.sellPct}%`, callback_data: `cfg_part_sellPct_${level}` },
     { text: `🎯 At: +${s.atPct}%`, callback_data: `cfg_part_atPct_${level}` }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Partial Sell Lv${level}</b>\n\nSell ${s.sellPct}% at +${s.atPct}% PNL\n\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgPartPromptInput(chatId, field, level) {
  const label = MENU.partLabels[field];
  if (!label) return;

  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const s = (cfg.partialSells || [])[level - 1];
  if (!s) return;

  pendingInputs.set(chatId, {
    type: 'partial',
    field,
    level,
    label: `Lv${level} ${label.label}`,
    hint: label.hint,
    min: label.min,
    max: label.max,
    current: s[field],
  });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Lv${level} ${label.label}</b>\n\nCurrent: <code>${s[field]}</code>\n\nType new value (${label.hint}):`,
    parse_mode: 'HTML',
  });
}

// ═══════════════════════════════════════════════════════════
// FILTER MODE HANDLERS
// ═══════════════════════════════════════════════════════════

async function cfgFilterSetMode(chatId, mode) {
  const { updateAutoConfig, getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const updates = { filterMode: mode };
  if (mode === 'custom' && !cfg.customFilters) {
    updates.customFilters = {
      minAgeMin: 15, maxAgeMin: 120,
      minMC: 20000, maxMC: 500000,
      minVolume: 10000,
      maxBundlerRate: 0.3,
      maxTop10HolderRate: 0.95,
      minBuyRatio: 1.2,
      minHolder: 0,
      // Pre-pump defaults
      minLiquidity: 8000,
      minSmartDegen: 1,
      maxEntrapment: 0.08,
      minSniper: 3,
      maxSniper: 50,
      // Momentum defaults
      minPriceChange5m: -10,
      maxPriceChange5m: 35,
      maxPriceChange1h: 150,
      minHotLevel: 1,
      minVisitingCount: 20,
    };
  }
  updateAutoConfig(updates);
  await sendConfigMenu(chatId);
}

async function cfgFilterAgeMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const f = cfg.customFilters || {};

  const buttons = [
    [{ text: `⏳ Min: ${f.minAgeMin || 15}m`, callback_data: 'cfg_filter_minAgeMin' },
     { text: `⏳ Max: ${f.maxAgeMin || 120}m`, callback_data: 'cfg_filter_maxAgeMin' }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Age Filter</b>\n\nMin: ${f.minAgeMin ?? 15} min\nMax: ${f.maxAgeMin ?? 120} min\n\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgFilterMcMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const f = cfg.customFilters || {};

  const buttons = [
    [{ text: `💰 Min: ${fmtMc(f.minMC || 0)}`, callback_data: 'cfg_filter_minMC' },
     { text: `💰 Max: ${fmtMc(f.maxMC || 500000)}`, callback_data: 'cfg_filter_maxMC' }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Market Cap Filter</b>\n\nMin: ${fmtMc(f.minMC || 0)}\nMax: ${fmtMc(f.maxMC || 500000)}\n\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgFilterSniperMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const f = cfg.customFilters || {};

  const buttons = [
    [{ text: `🎯 Min: ${f.minSniper || 3}`, callback_data: 'cfg_filter_minSniper' },
     { text: `🎯 Max: ${f.maxSniper || 50}`, callback_data: 'cfg_filter_maxSniper' }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Sniper Count Filter</b>\n\nMin: ${f.minSniper || 3}\nMax: ${f.maxSniper || 50}\n\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgFilterPrice5mMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const f = cfg.customFilters || {};

  const buttons = [
    [{ text: `📈 Min: ${f.minPriceChange5m ?? -10}%`, callback_data: 'cfg_filter_minPriceChange5m' },
     { text: `📈 Max: ${f.maxPriceChange5m ?? 35}%`, callback_data: 'cfg_filter_maxPriceChange5m' }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>5-Min Price Change Filter</b>\n\nMin: ${f.minPriceChange5m ?? -10}%\nMax: ${f.maxPriceChange5m ?? 35}%\n\nTokens outside this range will be filtered out.\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgFilterPromptInput(chatId, filterKey) {
  const field = MENU.filterLabels[filterKey];
  if (!field) return;

  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const current = cfg.customFilters?.[filterKey];

  pendingInputs.set(chatId, {
    type: 'filter',
    filterKey,
    label: field.label,
    hint: field.hint,
    min: field.min,
    max: field.max,
    current,
  });

  // Special display for rate fields
  let displayVal = current;
  if (filterKey === 'maxBundlerRate' || filterKey === 'maxTop10HolderRate') {
    displayVal = `${(current * 100).toFixed(0)}%`;
  }

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>${field.label}</b>\n\nCurrent: <code>${displayVal}</code>\n\nType new value (${field.hint}):`,
    parse_mode: 'HTML',
  });
}

// ═══════════════════════════════════════════════════════════
// SIGNAL SCANNER HANDLERS
// ═══════════════════════════════════════════════════════════

async function sendSignalMenu(chatId) {
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const sig = cfg.signalScanner || {};
  const w = sig.signalWeights || {};
  const dc = sig.antiDoubleCount || { enabled: true, factor: 0.5 };
  const dedupTtl = cfg.dedup?.globalTtlSec ?? 300;

  const names = MENU.signalNames;
  const weightLines = Object.entries(names).map(([id, name]) => {
    const defW = DEFAULT_SIGNAL_WEIGHTS[id] ?? 0;
    const curW = w[id] ?? defW;
    const changed = curW !== defW ? ' ✏️' : '';
    const icon = id === '18' ? '🚫' : (curW > 0 ? '🟢' : curW < 0 ? '🔴' : '⚪');
    return `  ${icon} ${name}: ${curW > 0 ? '+' : ''}${curW}${changed}`;
  });

  const lines = [
    `📡 <b>Signal Scanner</b>`,
    ``,
    `Status: ${sig.enabled !== false ? '✅ ON' : '❌ OFF'}`,
    `⏱ Interval: ${sig.intervalSec ?? 30}s`,
    `💰 MC Range: ${fmtMc(sig.mcMin ?? 10000)} - ${fmtMc(sig.mcMax ?? 500000)}`,
    ``,
    `⚙️ <b>Scoring:</b>`,
    `  📊 Signal Ratio: ${((sig.signalRatio ?? 0.30) * 100).toFixed(0)}%`,
    `  ⬇️ Min Contribution: ${sig.minContribution ?? 10}`,
    `  ⬆️ Max Contribution: ${sig.maxContribution ?? 25}`,
    `  🔄 Anti-Double-Count: ${dc.enabled !== false ? `✅ ON (${dc.factor ?? 0.5}x)` : '❌ OFF'}`,
    `  🌐 Dedup TTL: ${dedupTtl}s`,
    ``,
    `📋 <b>Signal Weights:</b>`,
    ...weightLines,
    ``,
    `✏️ = modified from default`,
  ];

  const buttons = [
    [{ text: sig.enabled !== false ? '🟢 Signal ON' : '🔴 Signal OFF', callback_data: 'cfg_signal_toggle' }],
    [{ text: `⏱ Interval: ${sig.intervalSec ?? 30}s`, callback_data: 'cfg_signal_input_intervalSec' }],
    [{ text: `💰 MC: ${fmtMc(sig.mcMin ?? 10000)}`, callback_data: 'cfg_signal_input_mcMin' },
     { text: `→ ${fmtMc(sig.mcMax ?? 500000)}`, callback_data: 'cfg_signal_input_mcMax' }],
    [{ text: `📊 Ratio: ${((sig.signalRatio ?? 0.30) * 100).toFixed(0)}%`, callback_data: 'cfg_signal_input_signalRatio' },
     { text: `⬇️ Min: ${sig.minContribution ?? 10}`, callback_data: 'cfg_signal_input_minContribution' }],
    [{ text: `⬆️ Max: ${sig.maxContribution ?? 25}`, callback_data: 'cfg_signal_input_maxContribution' },
     { text: dc.enabled !== false ? '🔄 Anti-DC ON' : '🔄 Anti-DC OFF', callback_data: 'cfg_signal_anti_dc' }],
    [{ text: `🌐 Dedup: ${dedupTtl}s`, callback_data: 'cfg_signal_input_dedupTtlSec' }],
    [{ text: '📋 Edit Weights', callback_data: 'cfg_signal_weight_edit' }],
    [{ text: '🔙 Back', callback_data: 'menu_config' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId, text: lines.join('\n'),
    parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
  });
}

const DEFAULT_SIGNAL_WEIGHTS = {
  1: 8, 2: -3, 3: 8, 4: 10, 5: -5, 6: 12, 7: -5, 8: 10,
  9: -5, 10: 8, 11: 8, 12: 8, 13: -5, 17: -3, 18: 0,
};

async function cfgSignalToggle(chatId, msgId, queryId) {
  const { getAutoConfig, updateAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const current = cfg.signalScanner?.enabled !== false;
  updateAutoConfig({ signalScanner: { ...(cfg.signalScanner || {}), enabled: !current } });
  const newCfg = getAutoConfig();
  await tgApi('editMessageReplyMarkup', {
    chat_id: chatId, message_id: msgId,
    reply_markup: JSON.stringify(configButtons(newCfg)),
  });
  await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: `Signal Scanner ${!current ? 'ON' : 'OFF'}` });
}

async function cfgSignalMcMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const sig = cfg.signalScanner || {};

  const buttons = [
    [{ text: `💰 Min: ${fmtMc(sig.mcMin ?? 10000)}`, callback_data: 'cfg_signal_input_mcMin' },
     { text: `💰 Max: ${fmtMc(sig.mcMax ?? 500000)}`, callback_data: 'cfg_signal_input_mcMax' }],
    [{ text: '🔙 Back', callback_data: 'menu_signal' }],
  ];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>Signal MC Range</b>\n\nMin: ${fmtMc(sig.mcMin ?? 10000)}\nMax: ${fmtMc(sig.mcMax ?? 500000)}\n\nTap to edit:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgSignalAntiDcToggle(chatId, msgId, queryId) {
  const { getAutoConfig, updateAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const dc = cfg.signalScanner?.antiDoubleCount || { enabled: true, factor: 0.5 };
  const newDc = { ...dc, enabled: dc.enabled === false ? true : false };
  updateAutoConfig({ signalScanner: { ...(cfg.signalScanner || {}), antiDoubleCount: newDc } });
  await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: `Anti-DC ${newDc.enabled ? 'ON' : 'OFF'}` });
  await sendSignalMenu(chatId);
}

async function cfgSignalPromptInput(chatId, signalKey) {
  const field = MENU.signalLabels[signalKey];
  if (!field) return;

  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const current = signalKey === 'dedupTtlSec' ? (cfg.dedup?.globalTtlSec ?? 300) : (cfg.signalScanner?.[signalKey] ?? 0);

  pendingInputs.set(chatId, {
    type: 'signal',
    signalKey,
    label: field.label,
    hint: field.hint,
    min: field.min,
    max: field.max,
    current,
  });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>${field.label}</b>\n\nCurrent: <code>${current}</code>\n\nType new value (${field.hint}):`,
    parse_mode: 'HTML',
  });
}

async function cfgSignalWeightsMenu(chatId) {
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const w = cfg.signalScanner?.signalWeights || {};
  const names = MENU.signalNames;

  const lines = [`📋 <b>Signal Weights</b>\n`];
  const buttons = [];

  for (const [id, name] of Object.entries(names)) {
    const defW = DEFAULT_SIGNAL_WEIGHTS[id] ?? 0;
    const curW = w[id] ?? defW;
    const icon = id === '18' ? '🚫' : (curW > 0 ? '🟢' : curW < 0 ? '🔴' : '⚪');
    lines.push(`${icon} <b>${name}</b>: ${curW > 0 ? '+' : ''}${curW}`);
    buttons.push([
      { text: `${icon} ${name}: ${curW > 0 ? '+' : ''}${curW}`, callback_data: `cfg_signal_weight_${id}` },
    ]);
  }

  buttons.push([{ text: '🔙 Back', callback_data: 'menu_signal' }]);

  await tgApi('sendMessage', {
    chat_id: chatId, text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgSignalWeightSelectMenu(chatId) {
  return cfgSignalWeightsMenu(chatId);
}

async function cfgSignalWeightPromptInput(chatId, typeId) {
  const name = MENU.signalNames[typeId];
  if (!name) return;

  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const w = cfg.signalScanner?.signalWeights || {};
  const defW = DEFAULT_SIGNAL_WEIGHTS[typeId] ?? 0;
  const current = w[typeId] ?? defW;

  // Quick-set buttons: positive range and negative range
  const buttons = [];
  if (typeId !== '18') {
    // Positive quick set
    buttons.push([
      { text: '+3', callback_data: `cfg_signal_wset_${typeId}_3` },
      { text: '+5', callback_data: `cfg_signal_wset_${typeId}_5` },
      { text: '+8', callback_data: `cfg_signal_wset_${typeId}_8` },
      { text: '+10', callback_data: `cfg_signal_wset_${typeId}_10` },
      { text: '+12', callback_data: `cfg_signal_wset_${typeId}_12` },
    ]);
    // Negative quick set
    buttons.push([
      { text: '-1', callback_data: `cfg_signal_wset_${typeId}_-1` },
      { text: '-3', callback_data: `cfg_signal_wset_${typeId}_-3` },
      { text: '-5', callback_data: `cfg_signal_wset_${typeId}_-5` },
      { text: '-8', callback_data: `cfg_signal_wset_${typeId}_-8` },
      { text: '-10', callback_data: `cfg_signal_wset_${typeId}_-10` },
    ]);
    // Reset to default
    buttons.push([
      { text: `↩️ Reset (${defW > 0 ? '+' : ''}${defW})`, callback_data: `cfg_signal_wset_${typeId}_${defW}` },
    ]);
  } else {
    // Type 18: hard reject toggle (weight 0 = disabled, weight 1 = reject)
    buttons.push([
      { text: '🚫 Reject', callback_data: `cfg_signal_wset_${typeId}_1` },
      { text: '⚪ Ignore', callback_data: `cfg_signal_wset_${typeId}_0` },
    ]);
  }
  buttons.push([{ text: '✏️ Custom Value', callback_data: `cfg_signal_input_w${typeId}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'cfg_signal_weights' }]);

  pendingInputs.set(chatId, {
    type: 'signal',
    signalKey: `w${typeId}`,
    label: `Weight: ${name}`,
    hint: 'e.g. 8 (positive boost) or -5 (negative penalty)',
    min: -50,
    max: 50,
    current,
  });

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✏️ <b>${name}</b>\n\nCurrent: <code>${current > 0 ? '+' : ''}${current}</code>\nDefault: <code>${defW > 0 ? '+' : ''}${defW}</code>\n\nTap quick-set or type custom:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function cfgSignalWeightSet(chatId, typeId, value) {
  const { getAutoConfig, updateAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const w = { ...(cfg.signalScanner?.signalWeights || {}) };
  w[typeId] = value;
  updateAutoConfig({ signalScanner: { ...(cfg.signalScanner || {}), signalWeights: w } });
  await cfgSignalWeightPromptInput(chatId, typeId);
}

// ═══════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════

async function handleSellButton(chatId, mintPrefix, pct) {
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const isDryMode = cfg.mode === 'dry_run';
  const open = isDryMode ? dryRun.getOpenDryPositions() : positions.getOpenPositions();
  const pos = open.find(p => p.tokenMint.startsWith(mintPrefix));
  if (!pos) return tgApi('sendMessage', { chat_id: chatId, text: '❌ Position not found', parse_mode: 'HTML' });

  // DRY RUN — virtual sell
  if (isDryMode) {
    const tokensToSell = pos.remainingTokens * (pct / 100);
    let virtualSol = 0;
    try {
      const rawAmount = Math.floor(tokensToSell * Math.pow(10, pos.decimals || 6));
      const { getQuote, SOL_MINT } = require('../src/trading');
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      virtualSol = parseFloat(quote.outAmount) / 1e9;
    } catch {
      virtualSol = tokensToSell * (pos.entryPrice || 0);
    }

    if (pct >= 100) {
      const closed = dryRun.closeDryPosition(pos.tokenMint, virtualSol, 'button');
      const emoji = closed.pnl >= 0 ? '🟢' : '🔴';
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `${emoji} <b>DRY RUN — Sell All ${pos.symbol}</b>\n\n💰 Would get: ~${virtualSol.toFixed(4)} SOL\n📊 PNL: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl.toFixed(4)} SOL (${closed.pnlPct}%)`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📊 Positions', callback_data: 'menu_positions' }, { text: '🔙 Main', callback_data: 'menu_main' }]] },
      });
    } else {
      dryRun.recordDryPartialSell(pos.tokenMint, tokensToSell, virtualSol, `button_${pct}pct`);
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🟡 <b>DRY RUN — Sell ${pct}% ${pos.symbol}</b>\n\n📦 Would sell: ${tokensToSell.toFixed(2)} tokens\n💰 Would get: ~${virtualSol.toFixed(4)} SOL`,
        parse_mode: 'HTML',
      });
    }
    return;
  }

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: `⏳ Selling ${pct}% of ${pos.symbol}...`, parse_mode: 'HTML' });

    const bal = await wallet.getTokenBalance(pos.tokenMint);
    if (bal.amount <= 0) throw new Error('No tokens found');

    const sellAmount = bal.amount * (pct / 100);
    const result = await trading.sellToken(pos.tokenMint, sellAmount, bal.decimals, 'default', 500);

    if (result.success) {
      if (pct >= 100) {
        positions.closePosition(pos.tokenMint, result.outputSol, result.signature, 'button');
      } else {
        positions.recordPartialSell(pos.tokenMint, sellAmount, result.outputSol, result.signature, `button_${pct}pct`);
      }
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Sold ${pct}% ${pos.symbol}</b>\n\n💰 Got: ${result.outputSol.toFixed(4)} SOL\n🔗 <a href="${result.explorer}">TX</a>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📊 Positions', callback_data: 'menu_positions' },
           { text: '🔙 Main', callback_data: 'menu_main' }],
        ]},
      });
    }
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Sell failed: ${e.message}`, parse_mode: 'HTML' });
  }
}

async function handleBuyButton(chatId, mintPrefix, amount) {
  clearPendingInput(chatId);
  const fs = require('fs');
  const path = require('path');
  let seen = {};
  // Try both trending and trenches seen files
  for (const src of ['trending', 'trenches', 'signal']) {
    try { 
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'output', `gmgn-seen-${src}.json`), 'utf8'));
      Object.assign(seen, data);
    } catch {}
  }

  const fullMint = Object.keys(seen).find(k => k.startsWith(mintPrefix));
  if (!fullMint) return tgApi('sendMessage', { chat_id: chatId, text: '❌ Token not found', parse_mode: 'HTML' });
  const symbol = seen[fullMint]?.symbol || fullMint.slice(0, 6);

  // DRY RUN — virtual buy via Jupiter quote (same as auto-trade)
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  if (cfg.mode === 'dry_run') {
    try {
      await tgApi('sendMessage', { chat_id: chatId, text: `🟡 DRY RUN — Buying ${amount} SOL of ${symbol}...`, parse_mode: 'HTML' });

      const { getQuote, SOL_MINT } = require('../src/trading');
      const lamports = Math.floor(amount * 1e9);
      const quote = await getQuote(SOL_MINT, fullMint, lamports, 500);
      const decimals = 6;
      const rawOutput = parseFloat(quote.outAmount || '0');
      const virtualTokenAmount = rawOutput / Math.pow(10, decimals);
      const entryPrice = virtualTokenAmount > 0 ? amount / virtualTokenAmount : 0;

      if (virtualTokenAmount <= 0) {
        await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Jupiter returned 0 tokens', parse_mode: 'HTML' });
        return;
      }

      const pos = dryRun.openDryPosition(fullMint, symbol, entryPrice, amount, virtualTokenAmount, decimals, {
        slPct: cfg.hardSlPct || cfg.slPct,
        trailingDropPct: cfg.trailingDropPct,
        trailingTriggerPct: cfg.trailingTriggerPct,
        trailingEnabled: true,
        mc: seen[fullMint]?.mc || 0,
      });

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🟡 <b>DRY RUN — Buy Success</b>\n\n💰 Spent: ${amount} SOL\n📦 Got: ${virtualTokenAmount.toFixed(2)} tokens\n📊 Entry: ${entryPrice.toFixed(10)} SOL/token`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📊 Positions', callback_data: 'menu_positions' }, { text: '🔙 Main', callback_data: 'menu_main' }]] },
      });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ DRY RUN Buy failed: ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: `⏳ Buying ${amount} SOL of ${seen[fullMint]?.symbol || fullMint.slice(0, 8)}...`, parse_mode: 'HTML' });

    const result = await trading.buyToken(fullMint, amount, 'default', 500);
    if (result.success) {
      const pos = positions.getPosition(fullMint);
      if (!pos) {
        const entryPrice = amount / (parseFloat(result.outputAmount || '0') / Math.pow(10, result.decimals || 6));
        positions.openPosition(fullMint, seen[fullMint]?.symbol || fullMint.slice(0, 6), entryPrice, amount,
          parseFloat(result.outputAmount || '0') / Math.pow(10, result.decimals || 6), result.decimals || 6, result.signature);
      }
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Buy Success</b>\n\n💰 Spent: ${amount} SOL\n📦 Got: ${result.tokenAmount?.toFixed(2) || '?'} tokens\n🔗 <a href="${result.explorer}">TX</a>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📊 Positions', callback_data: 'menu_positions' },
           { text: '🔙 Main', callback_data: 'menu_main' }],
        ]},
      });
    }
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Buy failed: ${e.message}`, parse_mode: 'HTML' });
  }
}

async function handleRefreshButton(chatId, mintPrefix) {
  clearPendingInput(chatId);
  const { getAutoConfig } = require('../src/autotrade');
  const cfg = getAutoConfig();
  const isDryMode = cfg.mode === 'dry_run';
  const open = isDryMode ? dryRun.getOpenDryPositions() : positions.getOpenPositions();
  const pos = open.find(p => p.tokenMint.startsWith(mintPrefix));
  if (!pos) return tgApi('sendMessage', { chat_id: chatId, text: '❌ Position not found', parse_mode: 'HTML' });

  const [quoteSolOut, liveMc, liveLiq] = await Promise.all([
    getQuoteSol(pos.tokenMint, pos.remainingTokens, pos.decimals),
    (async () => {
      try {
        const { gmgnTokenInfo } = require('../lib/shared');
        const info = await gmgnTokenInfo(pos.tokenMint);
        const price = parseFloat(info?.price?.price || 0);
        const supply = parseFloat(info?.circulating_supply || info?.total_supply || 0);
        return price * supply;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const { gmgnTokenPool } = require('../lib/shared');
        const pool = await gmgnTokenPool(pos.tokenMint);
        return parseFloat(pool?.liquidity || 0);
      } catch { return 0; }
    })(),
  ]);

  const quoteFailed = quoteSolOut === 0 && pos.remainingTokens > 0;
  const totalValueSol = quoteSolOut + (pos.totalSolReceived || 0);
  const pnlSol = totalValueSol - pos.solSpent;
  const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;
  const emoji = pnlSol >= 0 ? '🟢' : '🔴';

  // Track peak (only when quote is valid)
  if (!quoteFailed && pnlPct > (pos.peakPnlPct || 0)) {
    positions.updatePosition(pos.tokenMint, { peakPnlPct: pnlPct });
  }

  const ps = pos.partialSells || [];
  const psDone = ps.filter(s => s.sold).length;
  const psTotal = ps.length;

  const entryPrice = pos.solSpent / (pos.tokenAmount || 1);
  const currentPrice = (!quoteFailed && pos.remainingTokens > 0) ? (quoteSolOut / pos.remainingTokens) : 0;
  const priceChange = (!quoteFailed && entryPrice > 0) ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;

  const mcLine = pos.mc ? (
    liveMc > 0 ? `📈 MC: ${fmtMc(pos.mc)} → ${fmtMc(liveMc)}` : `📈 MC: ${fmtMc(pos.mc)}`
  ) : (liveMc > 0 ? `📈 MC: ${fmtMc(liveMc)}` : null);
  const liqLine = liveLiq > 0 ? `💧 Liq: ${fmtMc(liveLiq)}` : null;
  const lines = [
    `<b>${pos.symbol}</b>`,
    `<code>${pos.tokenMint}</code>`,
    mcLine,
    liqLine,
    ``,
    `💰 Entry: ${pos.solSpent.toFixed(4)} SOL`,
    quoteFailed
      ? `📈 Now: ⚠️ Quote unavailable`
      : `📈 Now: ${quoteSolOut.toFixed(4)} SOL (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%)`,
    quoteFailed
      ? `🔴 PNL: ⚠️ Quote unavailable`
      : `${emoji} PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    `📦 Remaining: ${pos.remainingTokens.toFixed(2)} tokens`,
    `🟡 Soft SL: -${cfg.softSlPct || 15}%/${cfg.softSlWaitSec || 30}s | 🛑 Hard SL: -${cfg.hardSlPct || cfg.slPct || 40}%`,
    pos.trailingEnabled ? `📍 Peak: +${(pos.peakPnlPct || 0).toFixed(1)}% | Trail: ${pos.trailingDropPct}%` : null,
    psTotal > 0 ? `🔸 Partial: ${psDone}/${psTotal} sold` : null,
    `💸 Sold: ${(pos.totalSolReceived || 0).toFixed(4)} SOL`,
  ].filter(Boolean);

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: positionButtons(pos.tokenMint),
  });
}

module.exports = {
  handleCallbackQuery,
  handlePendingInput,
  isPendingInput,
  clearPendingInput,
  sendMainMenu,
  mainMenu,
  positionButtons,
  configButtons,
  alertButtons,
  autoBuyButtons,
  sendSignalMenu,
};
