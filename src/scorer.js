/**
 * Quality scorer for pump.fun tokens
 * Scores 0-100 based on pump potential signals
 */

class QualityScorer {
  constructor() {
    this.weights = {
      creatorCommitment: 25,  // How much SOL creator spent
      metadataQuality: 20,    // Website, Twitter, description
      socialPresence: 20,     // Has real social links
      initialBuySize: 15,     // Size of creator's buy
      nameQuality: 10,        // Not spam name
      mayhemMode: 10          // Mayhem = more hype
    };
  }

  /**
   * Score a token at creation time
   * @param {Object} token - raw WS data
   * @param {Object|null} metadata - fetched metadata
   * @returns {{ score: number, breakdown: Object, signals: string[] }}
   */
  score(token, metadata) {
    const breakdown = {};
    const signals = [];

    // 1. Creator commitment (SOL spent)
    const solScore = this._scoreSolAmount(token.solAmount);
    breakdown.creatorCommitment = solScore;
    if (token.solAmount >= 5) signals.push('🐋 Whale creator (' + token.solAmount.toFixed(1) + ' SOL)');
    else if (token.solAmount >= 2) signals.push('💰 Solid creator spend (' + token.solAmount.toFixed(1) + ' SOL)');
    else if (token.solAmount >= 1) signals.push('✅ Decent creator spend');

    // 2. Metadata quality
    const metaScore = this._scoreMetadata(metadata);
    breakdown.metadataQuality = metaScore;
    if (metadata?.description && metadata.description.length > 50) signals.push('📝 Has description');

    // 3. Social presence
    const socialScore = this._scoreSocial(metadata);
    breakdown.socialPresence = socialScore;
    if (metadata?.website) signals.push('🌐 Has website');
    if (metadata?.twitter) signals.push('🐦 Has Twitter');
    if (metadata?.telegram) signals.push('📱 Has Telegram');

    // 4. Initial buy size
    const buyScore = this._scoreInitialBuy(token.initialBuy);
    breakdown.initialBuySize = buyScore;
    if (token.initialBuy >= 50_000_000) signals.push('🔥 Big initial buy (' + formatNum(token.initialBuy) + ')');

    // 5. Name quality (not spam)
    const nameScore = this._scoreName(token.name, token.symbol);
    breakdown.nameQuality = nameScore;
    if (nameScore < 5) signals.push('⚠️ Suspicious name');

    // 6. Mayhem mode
    const mayhemScore = token.is_mayhem_mode ? 10 : 0;
    breakdown.mayhemMode = mayhemScore;
    if (token.is_mayhem_mode) signals.push('🔥 Mayhem mode');

    // Total
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const score = Math.min(100, Math.round(total));

    return { score, breakdown, signals };
  }

  /**
   * Score post-creation trade activity
   * @param {Object} activity - tracked activity data
   * @returns {{ score: number, signals: string[] }}
   */
  scoreActivity(activity) {
    const signals = [];
    let score = 0;

    // Buy/sell ratio (higher = more buys)
    const totalTrades = activity.buys + activity.sells;
    if (totalTrades > 0) {
      const buyRatio = activity.buys / totalTrades;
      if (buyRatio >= 0.8) {
        score += 30;
        signals.push('🟢 Strong buying (' + Math.round(buyRatio * 100) + '% buys)');
      } else if (buyRatio >= 0.6) {
        score += 15;
        signals.push('🟢 More buys than sells');
      } else if (buyRatio < 0.4) {
        score -= 20;
        signals.push('🔴 Heavy selling');
      }
    }

    // Volume velocity (SOL per minute)
    const ageMinutes = Math.max(1, (Date.now() - activity.createdAt) / 60000);
    const solPerMin = activity.totalSolVolume / ageMinutes;
    if (solPerMin >= 1) {
      score += 25;
      signals.push('🚀 Fast volume (' + solPerMin.toFixed(2) + ' SOL/min)');
    } else if (solPerMin >= 0.3) {
      score += 10;
      signals.push('📈 Steady volume');
    }

    // Unique traders
    if (activity.uniqueTraders >= 10) {
      score += 20;
      signals.push('👥 ' + activity.uniqueTraders + ' unique traders');
    } else if (activity.uniqueTraders >= 5) {
      score += 10;
      signals.push('👥 ' + activity.uniqueTraders + ' traders');
    }

    // MC growth
    if (activity.mcGrowthPct >= 50) {
      score += 25;
      signals.push('📈 MC +' + activity.mcGrowthPct.toFixed(0) + '%');
    } else if (activity.mcGrowthPct >= 20) {
      score += 10;
      signals.push('📈 MC +' + activity.mcGrowthPct.toFixed(0) + '%');
    }

    return { score: Math.max(0, Math.min(100, score)), signals };
  }

  _scoreSolAmount(sol) {
    if (sol >= 10) return 25;
    if (sol >= 5) return 22;
    if (sol >= 2) return 18;
    if (sol >= 1) return 15;
    if (sol >= 0.5) return 10;
    return 5;
  }

  _scoreMetadata(meta) {
    if (!meta) return 0;
    let score = 0;
    if (meta.description && meta.description.length > 30) score += 8;
    if (meta.description && meta.description.length > 100) score += 4;
    if (meta.image) score += 4;
    if (meta.name && meta.name.length > 2) score += 4;
    return Math.min(20, score);
  }

  _scoreSocial(meta) {
    if (!meta) return 0;
    let score = 0;
    if (meta.website) score += 8;
    if (meta.twitter) score += 7;
    if (meta.telegram) score += 5;
    return Math.min(20, score);
  }

  _scoreInitialBuy(buy) {
    if (buy >= 100_000_000) return 15;
    if (buy >= 50_000_000) return 13;
    if (buy >= 20_000_000) return 10;
    if (buy >= 10_000_000) return 8;
    if (buy >= 1_000_000) return 5;
    return 2;
  }

  _scoreName(name, symbol) {
    const n = (name || '').toLowerCase();
    const s = (symbol || '').toLowerCase();

    // Spam patterns
    const spamPatterns = [
      /^(test|abc|xyz|aaa|bbb|ccc|123)/i,
      /^.{1,2}$/,  // too short
      /(.)\1{4,}/,  // repeated chars
    ];

    for (const pat of spamPatterns) {
      if (pat.test(n) || pat.test(s)) return 0;
    }

    // Good name patterns
    if (n.length >= 3 && n.length <= 20) return 10;
    if (n.length >= 3) return 7;
    return 3;
  }
}

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

module.exports = QualityScorer;
