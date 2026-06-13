const https = require('https');
const http = require('http');

/**
 * Fetch token metadata from URI (IPFS or direct)
 */
async function fetchMetadata(uri, timeoutMs = 5000) {
  if (!uri) return null;

  try {
    const url = normalizeUri(uri);
    const data = await httpGet(url, timeoutMs);
    if (!data) return null;

    return {
      name: data.name || null,
      symbol: data.symbol || null,
      description: data.description || null,
      image: data.image || null,
      website: data.website || data.external_url || null,
      twitter: data.twitter || data.socials?.twitter || null,
      telegram: data.telegram || data.socials?.telegram || null,
      discord: data.discord || data.socials?.discord || null
    };
  } catch (e) {
    return null;
  }
}

/**
 * Fetch real-time market data from DexScreener
 * Returns { priceUsd, mcUsd, liqUsd, volume24h, priceChange1h, buyRatio }
 */
async function fetchDexScreener(mint, timeoutMs = 5000) {
  if (!mint) return null;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const data = await httpGet(url, timeoutMs);
    if (!data || !data.pairs || data.pairs.length === 0) return null;

    // Get pumpswap pair (primary) or first pair
    const pair = data.pairs.find(p => p.dexId === 'pumpswap') || data.pairs[0];
    if (!pair) return null;

    const txns = pair.txns || {};
    const h1Buys = txns.h1?.buys || 0;
    const h1Sells = txns.h1?.sells || 0;
    const totalTxns = h1Buys + h1Sells;

    return {
      priceUsd: parseFloat(pair.priceUsd || '0'),
      mcUsd: pair.marketCap || pair.fdv || 0,
      liqUsd: pair.liquidity?.usd || 0,
      volume1h: pair.volume?.h1 || 0,
      volume24h: pair.volume?.h24 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      buyRatio: totalTxns > 0 ? h1Buys / totalTxns : 0.5,
      h1Buys,
      h1Sells,
      pairAddress: pair.pairAddress
    };
  } catch (e) {
    return null;
  }
}

function normalizeUri(uri) {
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  }
  if (uri.includes('ipfs.io/ipfs/')) {
    return uri.replace('ipfs.io/ipfs/', 'cloudflare-ipfs.com/ipfs/');
  }
  return uri;
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
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

module.exports = { fetchMetadata, fetchDexScreener };
