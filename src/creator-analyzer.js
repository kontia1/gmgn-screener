/**
 * Creator history analyzer for pump.fun tokens
 * Checks if creator is a serial launcher (many failed tokens = rug risk)
 */

const https = require('https');
const http = require('http');

class CreatorAnalyzer {
  constructor() {
    this.cache = new Map(); // creator -> { tokens, lastCheck }
    this.cacheTtlMs = 30 * 60 * 1000; // 30 min cache
  }

  /**
   * Analyze creator history
   * @param {string} creator - creator wallet address
   * @returns {Promise<{ isNew: boolean, totalTokens: number, successfulTokens: number, risk: string, flags: string[] }>}
   */
  async analyze(creator) {
    // Check cache
    const cached = this.cache.get(creator);
    if (cached && Date.now() - cached.lastCheck < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const tokens = await this._fetchCreatorTokens(creator);
      const result = this._analyzeTokens(tokens);

      // Cache result
      this.cache.set(creator, { data: result, lastCheck: Date.now() });
      return result;
    } catch (e) {
      return { isNew: true, totalTokens: 0, successfulTokens: 0, risk: 'unknown', flags: [] };
    }
  }

  _fetchCreatorTokens(creator) {
    return new Promise((resolve, reject) => {
      const url = `https://frontend-api-v3.pump.fun/coins?creator=${creator}&limit=20`;
      const req = https.get(url, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }

  _analyzeTokens(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { isNew: true, totalTokens: 0, successfulTokens: 0, risk: 'low', flags: ['✨ First-time creator'] };
    }

    const totalTokens = tokens.length;
    const successfulTokens = tokens.filter(t => (t.usd_market_cap || 0) > 10000).length;
    const failedTokens = totalTokens - successfulTokens;
    const flags = [];

    // Serial launcher detection
    if (totalTokens >= 5) {
      flags.push(`🔄 Serial launcher (${totalTokens} tokens)`);
      if (successfulTokens <= 1) {
        flags.push(`⚠️ ${failedTokens}/${totalTokens} tokens failed`);
      }
    }

    // Recent rapid launches (multiple tokens in short time)
    const recentTokens = tokens.filter(t => {
      const created = t.created_timestamp || 0;
      const ageHours = (Date.now() - created) / 3600000;
      return ageHours < 24;
    });
    if (recentTokens.length >= 3) {
      flags.push(`🚀 ${recentTokens.length} tokens in 24h`);
    }

    // Success rate
    const successRate = totalTokens > 0 ? successfulTokens / totalTokens : 0;

    let risk;
    if (totalTokens === 0) {
      risk = 'low';
    } else if (totalTokens === 1) {
      risk = 'low'; // First token, could be legit
    } else if (totalTokens >= 10 && successRate < 0.1) {
      risk = 'critical'; // Serial rugger
    } else if (totalTokens >= 5 && successRate < 0.2) {
      risk = 'high';
    } else if (totalTokens >= 3) {
      risk = 'medium';
    } else {
      risk = 'low';
    }

    return {
      isNew: totalTokens === 0,
      totalTokens,
      successfulTokens,
      failedTokens,
      successRate,
      risk,
      flags
    };
  }

  /**
   * Get penalty score for rug detection (0-40)
   */
  getPenalty(creatorAnalysis) {
    switch (creatorAnalysis.risk) {
      case 'critical': return 40;
      case 'high': return 25;
      case 'medium': return 10;
      case 'low': return 0;
      default: return 5;
    }
  }
}

module.exports = CreatorAnalyzer;
