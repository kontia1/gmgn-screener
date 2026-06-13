class TokenFilter {
  constructor(config) {
    this.config = config.filters;
    this.seen = new Map(); // mint -> timestamp for dedup
    this.dedupWindowMs = 60 * 60 * 1000; // 1 hour
  }

  /**
   * Check if token passes all filters
   * @param {Object} token - raw token data from WS
   * @returns {{ pass: boolean, reason?: string }}
   */
  check(token) {
    // Dedup - skip if seen recently
    if (this.seen.has(token.mint)) {
      return { pass: false, reason: 'duplicate' };
    }

    // Spam filter: initialBuy == 0 and solAmount == 0
    if (token.initialBuy === 0 && token.solAmount === 0) {
      return { pass: false, reason: 'spam (zero buy)' };
    }

    // Filter by solAmount
    if (token.solAmount < this.config.minSolAmount) {
      return { pass: false, reason: `solAmount ${token.solAmount} < ${this.config.minSolAmount}` };
    }
    if (this.config.maxSolAmount && token.solAmount > this.config.maxSolAmount) {
      return { pass: false, reason: `solAmount ${token.solAmount} > ${this.config.maxSolAmount}` };
    }

    // Filter by marketCapSol
    const mcSol = token.marketCapSol || 0;
    if (mcSol < this.config.minMarketCapSol) {
      return { pass: false, reason: `MC ${mcSol.toFixed(2)} SOL < ${this.config.minMarketCapSol}` };
    }
    if (this.config.maxMarketCapSol && mcSol > this.config.maxMarketCapSol) {
      return { pass: false, reason: `MC ${mcSol.toFixed(2)} SOL > ${this.config.maxMarketCapSol}` };
    }

    // Filter by initialBuyTokens
    if (token.initialBuy < this.config.minInitialBuyTokens) {
      return { pass: false, reason: `initialBuy ${token.initialBuy} < ${this.config.minInitialBuyTokens}` };
    }

    // Filter mayhem mode
    if (this.config.requireMayhemMode && !token.is_mayhem_mode) {
      return { pass: false, reason: 'not mayhem mode' };
    }

    // Filter excluded pools
    if (this.config.excludePools.includes(token.pool)) {
      return { pass: false, reason: `excluded pool: ${token.pool}` };
    }

    // Passed all filters
    this.seen.set(token.mint, Date.now());
    this._cleanup();
    return { pass: true };
  }

  _cleanup() {
    const cutoff = Date.now() - this.dedupWindowMs;
    for (const [mint, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(mint);
    }
  }

  get seenCount() {
    return this.seen.size;
  }
}

module.exports = TokenFilter;
