/**
 * Bundler Detector v3 — detect ACTIVE insider transfer burst pattern
 * + Historical learning + Data collection for pagination decision
 * 
 * KEY INSIGHT: Not all bundler activity is bad.
 * - Normal launch: creator distributes tokens to multiple wallets at launch (GOOD)
 * - Rug pattern: bundler gathers tokens AFTER people have bought (BAD)
 * 
 * Detection logic:
 * 1. Fetch recent transfers for token via Helius API (50 tx)
 * 2. Focus on VERY recent activity (last 30 seconds = "active now")
 * 3. Only flag as bundler if pattern is happening NOW, not historical
 * 4. Save detection data for future pagination analysis
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = 'https://api.helius.xyz/v0';
const fs = require('fs');
const path = require('path');

// Cache to avoid re-checking same token
const checkCache = new Map();
const CACHE_TTL = 15000; // 15 seconds

// History file for learning
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'bundler-history.json');

// ─── History Management ─────────────────────────────────
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { tokens: {}, wallets: {}, stats: {}, paginationAnalysis: {} };
  }
}

function saveHistory(history) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[BUNDLER] Save history failed:', e.message);
  }
}

function saveBundlerDetection(tokenMint, symbol, result, pnl = 0) {
  const history = loadHistory();
  const now = new Date().toISOString();
  
  // Save token detection
  if (!history.tokens[tokenMint]) {
    history.tokens[tokenMint] = {
      symbol,
      firstDetected: now,
      detections: [],
    };
  }
  
  history.tokens[tokenMint].lastDetected = now;
  history.tokens[tokenMint].symbol = symbol;
  history.tokens[tokenMint].detections.push({
    timestamp: now,
    isBundler: result.isBundler,
    hasHistory: result.hasHistory,
    transfersInBurst: result.transfers,
    uniquePayers: result.uniquePayers,
    totalTransfersAvailable: result.totalTransfersAvailable || 50,
    burstPosition: result.burstPosition || 'unknown',
    wouldPaginationHelp: result.wouldPaginationHelp || false,
    details: result.details,
    pnl,
  });
  
  // Keep only last 20 detections per token
  if (history.tokens[tokenMint].detections.length > 20) {
    history.tokens[tokenMint].detections = history.tokens[tokenMint].detections.slice(-20);
  }
  
  // Save wallet (fee payers) for blacklist learning
  // ONLY count wallets from ACTUAL bundler detections
  if (result.isBundler && result.payerWallets && result.payerWallets.length > 0) {
    for (const wallet of result.payerWallets) {
      if (!history.wallets[wallet]) {
        history.wallets[wallet] = { seenIn: [], bundlerCount: 0 };
      }
      if (!history.wallets[wallet].seenIn.includes(tokenMint)) {
        history.wallets[wallet].seenIn.push(tokenMint);
      }
      history.wallets[wallet].bundlerCount++;
      history.wallets[wallet].lastSeen = now;
      
      // Auto-blacklist kalau >=5x bundler (stricter to avoid false positive cascade)
      if (history.wallets[wallet].bundlerCount >= 5) {
        history.wallets[wallet].blacklisted = true;
        history.wallets[wallet].blacklistedAt = now;
      }
    }
  }
  
  // Update global stats
  history.stats.totalDetections = (history.stats.totalDetections || 0) + 1;
  history.stats.totalBundler = (history.stats.totalBundler || 0) + (result.isBundler ? 1 : 0);
  history.stats.totalHistorical = (history.stats.totalHistorical || 0) + (result.hasHistory ? 1 : 0);
  history.stats.totalPnl = (history.stats.totalPnl || 0) + pnl;
  history.stats.lastUpdated = now;
  
  // Pagination analysis data
  if (result.burstPosition) {
    if (!history.paginationAnalysis) history.paginationAnalysis = {};
    const pos = result.burstPosition;
    history.paginationAnalysis[pos] = (history.paginationAnalysis[pos] || 0) + 1;
    history.paginationAnalysis.total = (history.paginationAnalysis.total || 0) + 1;
  }
  
  saveHistory(history);
}

function isBlacklistedWallet(wallet) {
  const history = loadHistory();
  return history.wallets?.[wallet]?.blacklisted === true;
}

function isKnownBundlerToken(tokenMint) {
  const history = loadHistory();
  const tokenData = history.tokens?.[tokenMint];
  if (!tokenData) return false;
  const lastDetection = tokenData.detections?.slice(-1)[0];
  return lastDetection?.isBundler === true;
}

function getPaginationAnalysis() {
  const history = loadHistory();
  return history.paginationAnalysis || {};
}

// ─── Main Detection Function ─────────────────────────────
async function checkBundlerPattern(tokenMint, tokenSupply = 0, symbol = 'Unknown') {
  const cacheKey = tokenMint;
  const cached = checkCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  try {
    const url = `${HELIUS_BASE}/addresses/${tokenMint}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return { isBundler: false, hasHistory: false, details: 'API error', transfers: 0, uniquePayers: 0 };
    }

    const txs = await resp.json();
    if (!Array.isArray(txs) || txs.length === 0) {
      return { isBundler: false, hasHistory: false, details: 'No transactions', transfers: 0, uniquePayers: 0 };
    }

    // Filter transactions that contain actual TOKEN transfers (movement between wallets)
    // Helius returns tokenTransfers[] for many tx types, but not all are real transfers
    // Must have: non-SOL mint, non-zero amount, BOTH from and to accounts populated
    const VALID_TX_TYPES = new Set(['TRANSFER', 'SWAP', 'COMPRESSED_NFT_TRANSFER']);
    const transfers = txs.filter(tx => {
      // Check tokenTransfers[] for actual wallet-to-wallet token movements
      const tokenTx = (tx.tokenTransfers || []).filter(t => 
        t.mint && 
        t.mint !== 'So11111111111111111111111111111111111111112' &&
        t.fromUserAccount && t.toUserAccount && // Both sides must exist (actual transfer)
        Math.abs(t.tokenAmount || 0) > 0         // Non-zero amount
      );
      if (tokenTx.length > 0) return true;
      // Fallback: TRANSFER type with non-SOL description (legacy)
      if (VALID_TX_TYPES.has(tx.type)) {
        const desc = tx.description || '';
        if (desc.includes(' SOL ') || desc.includes(' SOL.')) return false;
        if (desc.match(/transferred [\d,.]+\s/)) return true;
      }
      return false;
    });
    if (transfers.length === 0) {
      return { isBundler: false, hasHistory: false, details: 'No transfers', transfers: 0, uniquePayers: 0 };
    }

    const now = Math.floor(Date.now() / 1000);

    // ─── Smart 50 TX Detection (no pagination needed) ───
    let isBundler = false;
    const reasons = [];
    let burstPosition = 'first_50';
    let wouldPaginationHelp = false;

    if (transfers.length === 50) {
      const oldest = transfers[transfers.length - 1].timestamp || 0;
      const newest = transfers[0].timestamp || 0;
      const spanSeconds = newest - oldest;
      
      // Count unique payers for 50-tx burst
      const burstPayers = new Set(transfers.map(tx => tx.feePayer || ''));
      
      // Only flag if few payers (real bundler = 1-3 wallets doing many transfers)
      // 10+ payers = organic launch rush, not bundler
      if (spanSeconds < 60 && burstPayers.size <= 5) {
        isBundler = true;
        reasons.push(`50 transactions in ${spanSeconds} seconds from ${burstPayers.size} payers`);
        burstPosition = 'first_50';
        wouldPaginationHelp = false;
      }
    }

    // ─── ACTIVE WINDOW: last 30 seconds ───
    const activeWindow = 30;
    const activeTransfers = transfers.filter(tx => {
      const ts = tx.timestamp || 0;
      return (now - ts) < activeWindow;
    });

    // ─── HISTORICAL WINDOW: 30s to 10min ago ───
    const historyTransfers = transfers.filter(tx => {
      const ts = tx.timestamp || 0;
      return (now - ts) >= activeWindow && (now - ts) < 600;
    });

    // ─── Analyze ACTIVE transfers ───
    const payerWallets = [];

    if (activeTransfers.length > 0) {
      const activePayers = new Set();
      let activeTokens = 0;
      const recipientCounts = {};

      for (const tx of activeTransfers) {
        const payer = tx.feePayer || '';
        activePayers.add(payer);
        if (!payerWallets.includes(payer)) payerWallets.push(payer);
        
        // Use tokenTransfers[] for accurate token counting (not description parsing)
        const tokenTx = (tx.tokenTransfers || []).filter(t => t.mint && t.mint !== 'So11111111111111111111111111111111111111112');
        for (const t of tokenTx) {
          const amt = Math.abs(t.tokenAmount || 0);
          if (amt <= 0) continue;
          activeTokens += amt;
          const recipient = t.toUserAccount || '';
          if (recipient) {
            recipientCounts[recipient] = (recipientCounts[recipient] || 0) + amt;
          }
        }
      }

      // Find largest recipient
      let maxRecipient = '';
      let maxRecipientAmount = 0;
      for (const [addr, amt] of Object.entries(recipientCounts)) {
        if (amt > maxRecipientAmount) {
          maxRecipientAmount = amt;
          maxRecipient = addr;
        }
      }

      // Rule 1: Many transfers, few payers — stricter for new tokens
      if (activeTransfers.length >= 20 && activePayers.size <= 2) {
        reasons.push(`${activeTransfers.length} transfers from ${activePayers.size} payers in ${activeWindow}s`);
        isBundler = true;
      }

      // Rule 2: Burst in < 5 seconds — only if few payers (real bundler = 1-2 wallets doing many transfers)
      const timestamps = activeTransfers.map(tx => tx.timestamp || 0).sort();
      let burstCount = 0;
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] - timestamps[i-1] < 5) {
          burstCount++;
        }
      }
      if (burstCount >= 15 && activePayers.size <= 3) {
        reasons.push(`${burstCount} transfers within 5 seconds from ${activePayers.size} payers`);
        isBundler = true;
      }

      // Rule 3: Large % of supply transferred to 1 wallet
      // DISABLED: tokenSupply is market cap ($), not actual supply — calculation is wrong
      // if (tokenSupply > 0 && maxRecipientAmount > 0) {
      //   const pctOfSupply = (maxRecipientAmount / tokenSupply) * 100;
      //   if (pctOfSupply > 10) {
      //     reasons.push(`${pctOfSupply.toFixed(1)}% supply to 1 wallet`);
      //     isBundler = true;
      //   }
      // }

      // Determine burst position for pagination analysis
      if (isBundler) {
        const burstInActive = activeTransfers.length;
        if (burstInActive >= 50) {
          burstPosition = 'first_50';
          wouldPaginationHelp = false;
        } else if (transfers.length === 50) {
          const oldestTx = transfers[transfers.length - 1].timestamp || 0;
          if ((now - oldestTx) < 120) {
            burstPosition = 'possibly_beyond_50';
            wouldPaginationHelp = true;
          }
        }
      }
    }

    // ─── Analyze HISTORICAL transfers ───
    let hasHistory = false;
    if (historyTransfers.length > 0) {
      const historyPayers = new Set();
      for (const tx of historyTransfers) {
        historyPayers.add(tx.feePayer || '');
      }
      if (historyTransfers.length >= 10 && historyPayers.size <= 3) {
        hasHistory = true;
      }
    }

    // Check blacklist — ONLY if there's already some transfer activity evidence
    // Don't blacklist-trigger on lone transfers (avoids false positive cascade)
    const blacklistedPayers = payerWallets.filter(w => isBlacklistedWallet(w));
    if (blacklistedPayers.length > 0 && activeTransfers.length >= 5) {
      isBundler = true;
      reasons.push(`Blacklisted wallet: ${blacklistedPayers[0].slice(0, 12)}...`);
    }

    const result = {
      isBundler,
      hasHistory,
      details: isBundler 
        ? `ACTIVE: ${reasons.join('; ')}` 
        : hasHistory 
          ? 'Historical bundler (normal launch)' 
          : 'Normal',
      transfers: activeTransfers.length,
      uniquePayers: activeTransfers.length > 0 ? new Set(activeTransfers.map(tx => tx.feePayer)).size : 0,
      historyTransfers: historyTransfers.length,
      totalTransfersAvailable: transfers.length,
      burstPosition,
      wouldPaginationHelp,
      payerWallets,
    };

    checkCache.set(cacheKey, { ts: Date.now(), result });
    return result;

  } catch (e) {
    console.error(`[BUNDLER] Error checking ${tokenMint}: ${e.message}`);
    return { isBundler: false, hasHistory: false, details: 'Error: ' + e.message, transfers: 0, uniquePayers: 0 };
  }
}

function clearCache(tokenMint) {
  checkCache.delete(tokenMint);
}

module.exports = { 
  checkBundlerPattern, 
  clearCache, 
  saveBundlerDetection, 
  isBlacklistedWallet, 
  isKnownBundlerToken,
  getPaginationAnalysis,
  loadHistory 
};
