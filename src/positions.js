/**
 * Position Tracker — track buys, sells, PNL, trailing TP, partial sell
 * Storage: data/positions.json
 */
const fs = require('fs');
const path = require('path');

const POSITIONS_FILE = path.join(__dirname, '..', 'data', 'positions.json');
const CLOSED_FILE = path.join(__dirname, '..', 'data', 'closed.json');

function loadPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    // Safety: must be object, not array (array string keys don't persist in JSON)
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}

function savePositions(positions) {
  const dir = path.dirname(POSITIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = POSITIONS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(positions, null, 2));
  fs.renameSync(tmpFile, POSITIONS_FILE);
}

// L27 FIX: validate that closed.json contains an array
function loadClosed() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLOSED_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch { return []; }
}

function saveClosed(closed) {
  const dir = path.dirname(CLOSED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = CLOSED_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(closed, null, 2));
  fs.renameSync(tmpFile, CLOSED_FILE);
}

// ─── H5 FIX: Async mutex to prevent read-modify-write race conditions ──
let _posLock = false;
const _posQueue = [];
async function withLock(fn) {
  while (_posLock) await new Promise(r => _posQueue.push(r));
  _posLock = true;
  try { return await fn(); }
  finally {
    _posLock = false;
    if (_posQueue.length) _posQueue.shift()();
  }
}

// ─── Internal (unlocked) versions — used for nested calls to avoid deadlock ─

// ─── Open Position (internal) ─────────────────────────────
// partialSells: [{atPct: 50, sellPct: 25, sold: false}, ...]
function _openPosition(tokenMint, symbol, entryPrice, solSpent, tokenAmount, decimals, txSignature, opts = {}) {
  const positions = loadPositions();

  // Don't overwrite existing position
  if (positions[tokenMint]) {
    console.warn(`[POS] Position for ${symbol} (${tokenMint}) already exists, skipping overwrite`);
    return positions[tokenMint];
  }

  const id = `${tokenMint}_${Date.now()}`;

  positions[tokenMint] = {
    id,
    tokenMint,
    symbol,
    entryPrice,
    solSpent,
    tokenAmount,
    remainingTokens: tokenAmount,  // decreases on partial sells
    decimals,
    txSignature,
    openedAt: new Date().toISOString(),

    // TP/SL
    slPct: opts.slPct || 50,
    hardSlPct: opts.hardSlPct || undefined,

    // Trailing TP
    trailingEnabled: opts.trailingEnabled !== false,
    trailingDropPct: opts.trailingDropPct || 15,   // sell when drops 15% from peak
    trailingTriggerPct: opts.trailingTriggerPct || 20, // activate trailing after peak PNL > X%
    peakPrice: entryPrice,                          // track highest price (SOL/token)
    peakPnlPct: 0,                                  // track highest PNL %

    // Partial sells: [{atPct, sellPct, sold, txSig}]
    partialSells: (opts.partialSells || [
      { atPct: 25,  sellPct: 50, sold: false, enabled: true },
      { atPct: 50,  sellPct: 25, sold: false, enabled: true },
      { atPct: 50,  sellPct: 25, sold: false, enabled: false },
    ]).map(s => ({ ...s, sold: false, txSig: null, enabled: s.enabled !== false })),

    // Market data
    mc: opts.mc || 0,

    // GMGN snapshot at entry (for rug detection)
    gmgnSnapshot: opts.gmgnSnapshot || null,

    // Tracking
    totalSolReceived: 0,
    sellHistory: [],
    status: 'open',
  };

  savePositions(positions);
  return positions[tokenMint];
}

// ─── Record Partial Sell (internal) ───────────────────────────
function _recordPartialSell(tokenMint, tokensSold, solReceived, txSignature, reason) {
  const positions = loadPositions();
  const pos = positions[tokenMint];
  if (!pos) return null;

  pos.remainingTokens = Math.max(0, pos.remainingTokens - tokensSold);
  pos.totalSolReceived += solReceived;
  pos.sellHistory.push({
    tokensSold,
    solReceived,
    txSignature,
    reason,
    timestamp: new Date().toISOString(),
  });

  // If fully sold, save first (so totalSolReceived is persisted), then close with 0 additional
  if (pos.remainingTokens <= 0) {
    savePositions(positions);
    return _closePosition(tokenMint, 0, txSignature, reason);  // uses internal version to avoid lock deadlock
  }

  savePositions(positions);
  return pos;
}

// ─── Close Position (internal) ────────────────────────────────
function _closePosition(tokenMint, solReceived, txSignature, reason = 'manual') {
  const positions = loadPositions();
  const pos = positions[tokenMint];
  if (!pos) throw new Error(`No open position for ${tokenMint}`);

  const prevReceived = pos.totalSolReceived || 0;
  const totalReceived = prevReceived + (solReceived || 0);
  const spent = pos.solSpent || 0;
  const pnl = totalReceived - spent;
  const pnlPct = spent > 0 ? ((totalReceived - spent) / spent * 100) : 0;

  const closed = {
    ...pos,
    solReceived: totalReceived,
    pnl: parseFloat(pnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct),
    closeTx: txSignature,
    closedAt: new Date().toISOString(),
    closeReason: reason,
    status: 'closed',
    remainingTokens: 0,
  };

  // Move to closed history
  const closedList = loadClosed();
  closedList.unshift(closed);
  // No cap — keep all closed trades for true all-time PNL
  saveClosed(closedList);

  // Remove from open positions
  delete positions[tokenMint];
  savePositions(positions);

  return closed;
}

// ─── Update Position (internal) ───────────────────────────────
function _updatePosition(tokenMint, updates) {
  const positions = loadPositions();
  if (!positions[tokenMint]) return null;
  Object.assign(positions[tokenMint], updates);
  savePositions(positions);
  return positions[tokenMint];
}

// ─── Check Trailing TP + Partial Sells + SL (internal) ────────
// M225 FIX: batch peak update — load once, mutate peak in-memory, save once at end
function _checkTpSl(pos, currentPrice) {
  const pnl = calcPnl(pos, currentPrice);
  const actions = [];
  let peakDirty = false;

  // Update peak price in-memory (no full load+save cycle)
  if (currentPrice > (pos.peakPrice || 0)) {
    pos.peakPrice = currentPrice;
    // TRAILING TP FIX: After partial sell reset, use remaining-only PNL (not total with realized gains)
    // This ensures the trailing TP tracks the REMAINING tokens' price action, not inflated total PNL
    pos.peakPnlPct = pos._partialSellReset
      ? ((currentPrice / pos.entryPrice) - 1) * 100
      : pnl.pnlPct;
    peakDirty = true;
  }

  // 1. Check partial sell levels (skip disabled ones with sellPct=0)
  const pendingPartials = (pos.partialSells || []).filter(s => !s.sold && s.enabled !== false);
  for (const partial of pendingPartials) {
    if (pnl.pnlPct >= partial.atPct) {
      actions.push({ type: 'partial', atPct: partial.atPct, sellPct: partial.sellPct });
    }
  }

  // 2. Check trailing TP (only after peak drops by trailingDropPct)
  if (pos.trailingEnabled && pos.peakPrice) {
    const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice * 100);
    const peakPnl = pos.peakPnlPct || 0;

    // Only trigger trailing if we've been in profit and now dropping
    const triggerPct = pos.trailingTriggerPct || 20;
    if (peakPnl > triggerPct && dropFromPeak >= (pos.trailingDropPct || 15)) {
      actions.push({ type: 'trailing', dropFromPeak: dropFromPeak.toFixed(1), peakPnl });
    }
  }

  // 3. Check hard SL (always on remaining position)
  if (pnl.pnlPct <= -(pos.slPct || 50)) {
    actions.push({ type: 'sl' });
  }

  // M225 FIX: single save for peak update if dirty
  if (peakDirty) {
    const positions = loadPositions();
    if (positions[pos.tokenMint]) {
      positions[pos.tokenMint].peakPrice = pos.peakPrice;
      positions[pos.tokenMint].peakPnlPct = pos.peakPnlPct;
      savePositions(positions);
    }
  }

  return { actions, ...pnl };
}

// ─── Public locked wrappers (transparent to callers) ───────────

function openPosition(tokenMint, symbol, entryPrice, solSpent, tokenAmount, decimals, txSignature, opts) {
  return withLock(() => _openPosition(tokenMint, symbol, entryPrice, solSpent, tokenAmount, decimals, txSignature, opts));
}

function recordPartialSell(tokenMint, tokensSold, solReceived, txSignature, reason) {
  return withLock(() => _recordPartialSell(tokenMint, tokensSold, solReceived, txSignature, reason));
}

function closePosition(tokenMint, solReceived, txSignature, reason) {
  return withLock(() => _closePosition(tokenMint, solReceived, txSignature, reason));
}

function updatePosition(tokenMint, updates) {
  return withLock(() => _updatePosition(tokenMint, updates));
}

function checkTpSl(pos, currentPrice) {
  return withLock(() => _checkTpSl(pos, currentPrice));
}

// ─── Read-only helpers (no lock needed) ────────────────────────

// ─── Get Position ──────────────────────────────────────
function getPosition(tokenMint) {
  return loadPositions()[tokenMint] || null;
}

// ─── Get All Open Positions ────────────────────────────
function getOpenPositions() {
  const positions = loadPositions();
  return Object.values(positions).filter(p => p.status === 'open');
}

// ─── Get Closed History ────────────────────────────────
function getClosedPositions(limit = 20) {
  return loadClosed().slice(0, limit);
}

// ─── Remove from Screening ─────────────────────────────
function removeFromScreening(tokenMint) {
  const seenDir = path.join(__dirname, '..', 'output');
  const lower = tokenMint.toLowerCase();
  // Remove from both trending and trenches seen files
  for (const source of ['trending', 'trenches']) {
    const seenFile = path.join(seenDir, `gmgn-seen-${source}.json`);
    try {
      const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      const actualKey = Object.keys(seen).find(k => k.toLowerCase() === lower);
      if (actualKey) {
        delete seen[actualKey];
        fs.writeFileSync(seenFile, JSON.stringify(seen, null, 2));
      }
    } catch {}
  }
  return false;
}

// ─── Calculate PNL for Open Position ───────────────────
function calcPnl(pos, currentPrice) {
  const currentValue = pos.remainingTokens * currentPrice;
  const totalValue = currentValue + pos.totalSolReceived;
  const pnl = totalValue - pos.solSpent;
  const pnlPct = pos.solSpent > 0 ? (pnl / pos.solSpent * 100) : 0;
  return {
    currentValue: parseFloat(currentValue.toFixed(6)),
    totalValue: parseFloat(totalValue.toFixed(6)),
    pnl: parseFloat(pnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct.toFixed(1)),
    isProfit: pnl >= 0,
    remainingTokens: pos.remainingTokens,
    totalSolReceived: pos.totalSolReceived,
  };
}

module.exports = {
  openPosition, closePosition, updatePosition, recordPartialSell,
  getPosition, getOpenPositions, getClosedPositions,
  removeFromScreening, calcPnl, checkTpSl,
  loadPositions, savePositions,
};
