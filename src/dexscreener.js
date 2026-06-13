/**
 * DexScreener API client for Solana token discovery
 * Finds tokens that are already trending, not just created
 */

const https = require('https');

class DexScreenerClient {
  constructor() {
    this.baseUrl = 'https://api.dexscreener.com';
  }

  /**
   * Get trending/boosted tokens on Solana
   */
  async getBoostedTokens(limit = 20) {
    const data = await this._get('/token-boosts/latest/v1');
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => t.chainId === 'solana')
      .slice(0, limit)
      .map(t => ({
        mint: t.tokenAddress,
        description: t.description || '',
        boostAmount: t.totalAmount || 0,
        icon: t.icon || null
      }));
  }

  /**
   * Get token details from DexScreener
   */
  async getTokenDetails(mint) {
    const data = await this._get(`/latest/dex/tokens/${mint}`);
    if (!data?.pairs?.length) return null;

    const pair = data.pairs.find(p => p.dexId === 'pumpswap') || data.pairs[0];
    if (!pair) return null;

    const txns = pair.txns || {};
    return {
      mint,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      baseSymbol: pair.baseToken?.symbol,
      baseName: pair.baseToken?.name,
      priceUsd: parseFloat(pair.priceUsd || '0'),
      mcUsd: pair.marketCap || pair.fdv || 0,
      liqUsd: pair.liquidity?.usd || 0,
      volume5m: pair.volume?.m5 || 0,
      volume1h: pair.volume?.h1 || 0,
      volume6h: pair.volume?.h6 || 0,
      volume24h: pair.volume?.h24 || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange6h: pair.priceChange?.h6 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      txns1h: { buys: txns.h1?.buys || 0, sells: txns.h1?.sells || 0 },
      txns6h: { buys: txns.h6?.buys || 0, sells: txns.h6?.sells || 0 },
      txns24h: { buys: txns.h24?.buys || 0, sells: txns.h24?.sells || 0 },
      pairCreatedAt: pair.pairCreatedAt || 0,
      website: pair.info?.websites?.[0]?.url || null,
      twitter: pair.info?.socials?.find(s => s.type === 'twitter')?.url || null,
      telegram: pair.info?.socials?.find(s => s.type === 'telegram')?.url || null,
      imageUrl: pair.info?.imageUrl || null
    };
  }

  /**
   * Search for tokens by query
   */
  async searchTokens(query) {
    const data = await this._get(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!data?.pairs) return [];
    return data.pairs
      .filter(p => p.chainId === 'solana' || p.dexId?.includes('pump'))
      .slice(0, 20)
      .map(p => ({
        mint: p.baseToken?.address,
        symbol: p.baseToken?.symbol,
        name: p.baseToken?.name,
        mcUsd: p.marketCap || p.fdv || 0,
        volume24h: p.volume?.h24 || 0,
        priceChange24h: p.priceChange?.h24 || 0
      }));
  }

  /**
   * Get new pairs on Solana (recently created)
   */
  async getNewPairs() {
    const data = await this._get('/token-profiles/latest/v2');
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => t.chainId === 'solana')
      .slice(0, 30)
      .map(t => ({
        mint: t.tokenAddress,
        description: t.description || '',
        links: t.links || []
      }));
  }

  _get(path) {
    return new Promise((resolve) => {
      const url = `${this.baseUrl}${path}`;
      const req = https.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
}

module.exports = DexScreenerClient;
