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

function loadClosed() {
  try { return JSON.parse(fs.readFileSync(CLOSED_FILE, 'utf8')); }
  catch { return []; }
}

function saveClosed(closed) {
  const dir = path.dirname(CLOSED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = CLOSED_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(closed, null, 2));
  fs.renameSync(tmpFile, CLOSED_FILE);
}

// ─── Open Position ─────────────────────────────────────
// partialSells: [{atPct: 50, sellPct: 25, sold: false}, ...]
function openPosition(tokenMint, symbol, entryPrice, solSpent, tokenAmount, decimals, txSignature, opts = {}) {
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

    // Trailing TP
    trailingEnabled: opts.trailingEnabled !== false,
    trailingDropPct: opts.trailingDropPct || 15,   // sell when drops 15% from peak
    trailingTriggerPct: opts.trailingTriggerPct || 20, // activate trailing after peak PNL > X%
    peakPrice: entryPrice,                          // track highest price (SOL/token)
    peakPnlPct: 0,                                  // track highest PNL %

    // Partial sells: [{atPct, sellPct, sold, txSig}]
    partialSells: (opts.partialSells || [
      { atPct: 50,  sellPct: 50, sold: false, enabled: true },
      { atPct: 100, sellPct: 25, sold: false, enabled: true },
      { atPct: 200, sellPct: 25, sold: false, enabled: true },
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

// ─── Record Partial Sell ───────────────────────────────
function recordPartialSell(tokenMint, tokensSold, solReceived, txSignature, reason) {
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
    return closePosition(tokenMint, 0, txSignature, reason);
  }

  savePositions(positions);
  return pos;
}

// ─── Close Position ────────────────────────────────────
function closePosition(tokenMint, solReceived, txSignature, reason = 'manual') {
  const positions = loadPositions();
  const pos = positions[tokenMint];
  if (!pos) throw new Error(`No open position for ${tokenMint}`);

  const totalReceived = pos.totalSolReceived + solReceived;
  const pnl = totalReceived - pos.solSpent;
  const pnlPct = ((totalReceived - pos.solSpent) / pos.solSpent * 100).toFixed(1);

  const closed = {
    ...pos,
    solReceived: totalReceived,
    pnl: parseFloat(pnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct),
    closeTx: txSignature,
    closedAt: new Date().toISOString(),
    closeReason: reason,
  };

  // Move to closed history
  const closedList = loadClosed();
  closedList.unshift(closed);
  if (closedList.length > 100) closedList.length = 100;
  saveClosed(closedList);

  // Remove from open positions
  delete positions[tokenMint];
  savePositions(positions);

  return closed;
}

// ─── Update Position ───────────────────────────────────
function updatePosition(tokenMint, updates) {
  const positions = loadPositions();
  if (!positions[tokenMint]) return null;
  Object.assign(positions[tokenMint], updates);
  savePositions(positions);
  return positions[tokenMint];
}

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

// ─── Check Trailing TP + Partial Sells + SL ────────────
// Returns: { actions: ['partial_50', 'trailing', 'sl', 'hold'], pnl, partials, ... }
function checkTpSl(pos, currentPrice) {
  const pnl = calcPnl(pos, currentPrice);
  const actions = [];

  // Update peak price
  if (currentPrice > (pos.peakPrice || 0)) {
    updatePosition(pos.tokenMint, {
      peakPrice: currentPrice,
      peakPnlPct: pnl.pnlPct,
    });
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

  return { actions, ...pnl };
}

module.exports = {
  openPosition, closePosition, updatePosition, recordPartialSell,
  getPosition, getOpenPositions, getClosedPositions,
  removeFromScreening, calcPnl, checkTpSl,
  loadPositions, savePositions,
};
