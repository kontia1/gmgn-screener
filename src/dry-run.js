/**
 * Dry Run Module — Virtual trade engine (no on-chain transactions)
 * Mirrors positions.js with separate storage files
 * NEVER touches live positions.json or closed.json
 */
const fs = require('fs');
const path = require('path');

const DRY_POSITIONS_FILE = path.join(__dirname, '..', 'data', 'dry-run-positions.json');
const DRY_CLOSED_FILE = path.join(__dirname, '..', 'data', 'dry-run-closed.json');

// ─── Load/Save Dry Run Positions ──────────────────────
function loadDryPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(DRY_POSITIONS_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}

function saveDryPositions(positions) {
  const dir = path.dirname(DRY_POSITIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = DRY_POSITIONS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(positions, null, 2));
  fs.renameSync(tmpFile, DRY_POSITIONS_FILE);
}

function loadDryClosed() {
  try { return JSON.parse(fs.readFileSync(DRY_CLOSED_FILE, 'utf8')); }
  catch { return []; }
}

function saveDryClosed(closed) {
  const dir = path.dirname(DRY_CLOSED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = DRY_CLOSED_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(closed, null, 2));
  fs.renameSync(tmpFile, DRY_CLOSED_FILE);
}

// ─── Open Virtual Position ─────────────────────────────
function openDryPosition(tokenMint, symbol, entryPrice, solSpent, tokenAmount, decimals, opts = {}) {
  const positions = loadDryPositions();

  if (positions[tokenMint]) {
    console.warn(`[DRY] Position for ${symbol} (${tokenMint}) already exists, skipping`);
    return positions[tokenMint];
  }

  const id = `dry_${tokenMint}_${Date.now()}`;

  positions[tokenMint] = {
    id,
    tokenMint,
    symbol,
    entryPrice,
    solSpent,
    tokenAmount,
    remainingTokens: tokenAmount,
    decimals,
    txSignature: 'DRY_RUN',
    openedAt: new Date().toISOString(),

    // TP/SL
    slPct: opts.slPct || 50,
    hardSlPct: opts.hardSlPct || undefined,

    // Trailing TP
    trailingEnabled: opts.trailingEnabled !== false,
    trailingDropPct: opts.trailingDropPct || 15,
    trailingTriggerPct: opts.trailingTriggerPct || 20,
    peakPrice: entryPrice,
    peakPnlPct: 0,

    // Partial sells
    partialSells: (opts.partialSells || [
      { atPct: 50,  sellPct: 50, sold: false, enabled: true },
      { atPct: 100, sellPct: 25, sold: false, enabled: true },
      { atPct: 200, sellPct: 25, sold: false, enabled: true },
    ]).map(s => ({ ...s, sold: false, txSig: null, enabled: s.enabled !== false })),

    // Market data
    mc: opts.mc || 0,

    // GMGN snapshot at entry
    gmgnSnapshot: opts.gmgnSnapshot || null,

    // Tracking
    totalSolReceived: 0,
    sellHistory: [],
    status: 'open',

    // Mark as dry run
    isDryRun: true,
  };

  saveDryPositions(positions);
  return positions[tokenMint];
}

// ─── Record Partial Sell (Virtual) ─────────────────────
function recordDryPartialSell(tokenMint, tokensSold, solVirtual, reason) {
  const positions = loadDryPositions();
  const pos = positions[tokenMint];
  if (!pos) return null;

  pos.remainingTokens = Math.max(0, pos.remainingTokens - tokensSold);
  pos.totalSolReceived += solVirtual;
  pos.sellHistory.push({
    tokensSold,
    solReceived: solVirtual,
    txSignature: 'DRY_RUN',
    reason,
    timestamp: new Date().toISOString(),
  });

  if (pos.remainingTokens <= 0) {
    saveDryPositions(positions);
    return closeDryPosition(tokenMint, 0, reason);
  }

  saveDryPositions(positions);
  return pos;
}

// ─── Close Virtual Position ────────────────────────────
function closeDryPosition(tokenMint, solVirtual, reason = 'manual') {
  const positions = loadDryPositions();
  const pos = positions[tokenMint];
  if (!pos) throw new Error(`No dry run position for ${tokenMint}`);

  const totalReceived = pos.totalSolReceived + solVirtual;
  const pnl = totalReceived - pos.solSpent;
  const pnlPct = ((totalReceived - pos.solSpent) / pos.solSpent * 100).toFixed(1);

  // Update pos.totalSolReceived BEFORE spread (so closed object has correct value)
  pos.totalSolReceived = totalReceived;

  const closed = {
    ...pos,
    solReceived: totalReceived,
    pnl: parseFloat(pnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct),
    closeTx: 'DRY_RUN',
    closedAt: new Date().toISOString(),
    closeReason: reason,
    isDryRun: true,
    status: 'closed',
    remainingTokens: 0,
  };

  const closedList = loadDryClosed();
  closedList.unshift(closed);
  if (closedList.length > 100) closedList.length = 100;
  saveDryClosed(closedList);

  delete positions[tokenMint];
  saveDryPositions(positions);

  return closed;
}

// ─── Get Dry Run Position ──────────────────────────────
function getDryPosition(tokenMint) {
  return loadDryPositions()[tokenMint] || null;
}

// ─── Get All Open Dry Run Positions ────────────────────
function getOpenDryPositions() {
  const positions = loadDryPositions();
  return Object.values(positions).filter(p => p.status === 'open');
}

// ─── Get Closed Dry Run History ────────────────────────
function getClosedDryPositions(limit = 20) {
  return loadDryClosed().slice(0, limit);
}

// ─── Update Dry Run Position ───────────────────────────
function updateDryPosition(tokenMint, updates) {
  const positions = loadDryPositions();
  if (!positions[tokenMint]) return null;
  Object.assign(positions[tokenMint], updates);
  saveDryPositions(positions);
  return positions[tokenMint];
}

// ─── Calculate PNL (same as live) ──────────────────────
function calcDryPnl(pos, currentPrice) {
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

// ─── Remove from Screening ─────────────────────────────
function removeFromDryScreening(tokenMint) {
  const seenDir = path.join(__dirname, '..', 'output');
  const lower = tokenMint.toLowerCase();
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

module.exports = {
  openDryPosition, closeDryPosition, updateDryPosition,
  recordDryPartialSell,
  getDryPosition, getOpenDryPositions, getClosedDryPositions,
  calcDryPnl, removeFromDryScreening,
  loadDryPositions, saveDryPositions,
  loadDryClosed, saveDryClosed,
};
