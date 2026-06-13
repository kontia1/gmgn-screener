/**
 * Rug detection signals for pump.fun tokens
 * Returns risk flags that reduce quality score
 */

class RugDetector {
  constructor() {
    // Known rug patterns in names/symbols
    this.spamPatterns = [
      /^(test|abc|xyz|aaa|bbb|ccc|123|xxx|coin|token)$/i,
      /^.{1,2}$/,  // too short (1-2 chars)
      /(.)\1{4,}/,  // repeated chars aaaa
      /^(ca|na|idk|meme|lol|wtf|bruh|sus)$/i,  // lazy names
      /^(usdc|usdt|sol|eth|btc|dai)$/i,  // impersonating real tokens
    ];

    // Fake websites (NOT real project sites)
    this.fakeWebsitePatterns = [
      /x\.com\/.*\/status\//i,  // just a tweet link
      /twitter\.com\/.*\/status\//i,
      /t\.me\//i,  // telegram links aren't websites
      /discord\.gg\//i,
      /dexscreener\.com/i,
      /pump\.fun/i,
      /birdeye/i,
      /jup\.ag/i,
      /solscan/i,
      /explorer/i,
    ];

    // Real project domains (game, app, platform)
    this.realWebsitePatterns = [
      /\.games?\//i,
      /\.app\//i,
      /\.io\//i,
      /\.xyz\//i,
      /\.com\//i,
      /linktree/i,
      /linktr\.ee/i,
    ];

    // Known scam Twitter handles
    this.scamTwitterPatterns = [
      /pmamtraveller/i,
      /onchaind3vor/i,
      /mtslive/i,
    ];

    // Mass launch platforms
    this.massLaunchPlatforms = [
      /uxento/i,
      /pump\.fun\/launch/i,
    ];
  }

  /**
   * Analyze token for rug signals
   * @param {Object} token - raw WS data
   * @param {Object|null} metadata - fetched metadata
   * @param {Object|null} creatorAnalysis - creator history analysis
   * @returns {{ riskScore: number (0-100, higher = more risky), flags: string[] }}
   */
  analyze(token, metadata, creatorAnalysis) {
    const flags = [];
    let risk = 0;

    // 1. Creator history penalty
    if (creatorAnalysis) {
      const creatorPenalty = this._getCreatorPenalty(creatorAnalysis);
      risk += creatorPenalty;
      if (creatorAnalysis.flags.length > 0) {
        flags.push(...creatorAnalysis.flags);
      }
    }

    // 2. Creator initial buy too high (% of total supply)
    const totalSupply = 1_000_000_000_000; // pump.fun default (1T)
    const creatorPct = (token.initialBuy / totalSupply) * 100;
    if (creatorPct >= 20) {
      risk += 30;
      flags.push(`🐋 Creator owns ${creatorPct.toFixed(1)}% supply`);
    } else if (creatorPct >= 10) {
      risk += 15;
      flags.push(`⚠️ Creator owns ${creatorPct.toFixed(1)}% supply`);
    }

    // 3. Very low creator spend
    if (token.solAmount < 0.1) {
      risk += 20;
      flags.push('🤖 Very low creator spend');
    } else if (token.solAmount < 0.3) {
      risk += 10;
      flags.push('📉 Low creator spend');
    }

    // 4. Spam name/symbol
    const name = (token.name || '').trim();
    const symbol = (token.symbol || '').trim();
    for (const pattern of this.spamPatterns) {
      if (pattern.test(name) || pattern.test(symbol)) {
        risk += 20;
        flags.push('📛 Spam-style name');
        break;
      }
    }

    // 5. Website quality check
    if (metadata?.website) {
      const isFake = this.fakeWebsitePatterns.some(p => p.test(metadata.website));
      if (isFake) {
        risk += 15;
        flags.push('🔗 Website is just a social link');
      } else {
        // Has real website — bonus!
        risk -= 10;
        flags.push('🌐 Has real website');
      }
    } else {
      risk += 10;
      flags.push('👻 No website');
    }

    // 6. No metadata at all
    if (!metadata || (!metadata.description && !metadata.image)) {
      risk += 15;
      flags.push('👻 No metadata');
    }

    // 7. Twitter check
    if (metadata?.twitter) {
      const isScam = this.scamTwitterPatterns.some(p => p.test(metadata.twitter));
      if (isScam) {
        risk += 20;
        flags.push('🐦 Known scam Twitter');
      } else {
        // Has Twitter — slight bonus
        risk -= 5;
      }
    } else {
      risk += 5;
    }

    // 8. Mass launch platform
    if (token.uri) {
      const isMassLaunch = this.massLaunchPlatforms.some(p => p.test(token.uri));
      if (isMassLaunch) {
        risk += 10;
        flags.push('🏭 Mass-launched');
      }
    }

    // 9. Mayhem + low spend
    if (token.is_mayhem_mode && token.solAmount < 1) {
      risk += 10;
      flags.push('🔥 Mayhem + low spend');
    }

    return {
      riskScore: Math.max(0, Math.min(100, risk)),
      flags
    };
  }

  _getCreatorPenalty(analysis) {
    switch (analysis.risk) {
      case 'critical': return 40;
      case 'high': return 25;
      case 'medium': return 10;
      case 'low': return 0;
      default: return 5;
    }
  }
}

module.exports = RugDetector;
