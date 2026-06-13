/**
 * Activity tracker for post-creation token monitoring
 * Tracks buys/sells, volume, unique traders for tokens that pass initial filter
 */

class ActivityTracker {
  constructor() {
    // mint -> activity data
    this.tracked = new Map();
    // How long to track each token (ms)
    this.trackDurationMs = 10 * 60 * 1000; // 10 minutes
    // Cleanup interval
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
  }

  /**
   * Start tracking a token
   */
  startTracking(mint, initialMcSol) {
    this.tracked.set(mint, {
      mint,
      createdAt: Date.now(),
      initialMcSol,
      currentMcSol: initialMcSol,
      buys: 0,
      sells: 0,
      buySolVolume: 0,
      sellSolVolume: 0,
      totalSolVolume: 0,
      uniqueTraders: new Set(),
      mcGrowthPct: 0,
      lastUpdate: Date.now()
    });
  }

  /**
   * Record a trade event
   * @param {Object} trade - { mint, traderPublicKey, solAmount, txType: 'buy'|'sell', marketCapSol }
   */
  recordTrade(trade) {
    const activity = this.tracked.get(trade.mint);
    if (!activity) return null;

    const isBuy = trade.txType === 'buy';
    const solAmount = trade.solAmount || 0;

    if (isBuy) {
      activity.buys++;
      activity.buySolVolume += solAmount;
    } else {
      activity.sells++;
      activity.sellSolVolume += solAmount;
    }

    activity.totalSolVolume += solAmount;
    activity.uniqueTraders.add(trade.traderPublicKey);
    activity.currentMcSol = trade.marketCapSol || activity.currentMcSol;
    activity.mcGrowthPct = ((activity.currentMcSol - activity.initialMcSol) / activity.initialMcSol) * 100;
    activity.lastUpdate = Date.now();

    return activity;
  }

  /**
   * Get activity for a mint
   */
  getActivity(mint) {
    return this.tracked.get(mint) || null;
  }

  /**
   * Check if token is still being tracked
   */
  isTracked(mint) {
    return this.tracked.has(mint);
  }

  /**
   * Get summary for display
   */
  getSummary(mint) {
    const a = this.tracked.get(mint);
    if (!a) return null;

    const ageMin = Math.max(1, (Date.now() - a.createdAt) / 60000);
    return {
      mint: a.mint,
      ageMinutes: ageMin.toFixed(1),
      buys: a.buys,
      sells: a.sells,
      buyRatio: (a.buys + a.sells) > 0 ? (a.buys / (a.buys + a.sells) * 100).toFixed(0) + '%' : 'N/A',
      totalVolume: a.totalSolVolume.toFixed(3) + ' SOL',
      uniqueTraders: a.uniqueTraders.size,
      mcGrowth: a.mcGrowthPct.toFixed(1) + '%',
      currentMcSol: a.currentMcSol.toFixed(2) + ' SOL'
    };
  }

  _cleanup() {
    const cutoff = Date.now() - this.trackDurationMs;
    for (const [mint, activity] of this.tracked) {
      if (activity.createdAt < cutoff) {
        this.tracked.delete(mint);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
  }
}

module.exports = ActivityTracker;
