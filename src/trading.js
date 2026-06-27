/**
 * Trading Module — Jupiter V6 swap (buy/sell)
 * SOL ↔ SPL Token
 * Uses Jupiter API key for premium routing + higher rate limits
 */
const { Transaction, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { getKeypair, getConnection } = require('./wallet');
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
const { OnlinePumpSdk, PumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, bondingCurvePda } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');

const JUPITER_API = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
const JUPITER_KEY = process.env.JUPITER_API_KEY || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const GMGN_API_KEY = process.env.GMGN_API_KEY || '';

// Find PumpSwap AMM pool — tries canonical PDA, then falls back to GMGN pool data
async function findPumpSwapPool(conn, mint) {
  // 1. Try canonical PDA
  const pda = canonicalPumpPoolPda(mint);
  const info = await conn.getAccountInfo(pda);
  if (info && info.owner.toBase58() === PUMP_AMM_PROGRAM) {
    return { poolKey: pda, source: 'pda' };
  }

  // 2. Fallback: fetch pool address from GMGN token info API
  try {
    const ts = Math.floor(Date.now() / 1000);
    const clientId = 'gmgn-' + ts;
    const url = `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=${mint.toBase58()}&timestamp=${ts}&client_id=${clientId}`;
    const resp = await fetch(url, {
      headers: { 'X-APIKEY': GMGN_API_KEY },
      signal: AbortSignal.timeout(8000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const poolAddr = data?.data?.pool?.pool_address;
      if (poolAddr) {
        const pk = new PublicKey(poolAddr);
        const poolInfo = await conn.getAccountInfo(pk);
        if (poolInfo && poolInfo.owner.toBase58() === PUMP_AMM_PROGRAM) {
          console.log(`[TRADE] Pool found via GMGN: ${poolAddr} (PDA was ${pda.toBase58()})`);
          return { poolKey: pk, source: 'gmgn' };
        }
      }
    }
  } catch (e) {
    console.log(`[TRADE] GMGN pool lookup failed: ${e.message}`);
  }

  return null;
}

// Build headers with API key if available
function jupHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (JUPITER_KEY) h['x-api-key'] = JUPITER_KEY;
  return h;
}

// ─── Jupiter Quote ─────────────────────────────────────
// maxAccounts omitted = Jupiter determines optimal routing automatically
async function getQuote(inputMint, outputMint, amount, slippageBps = 300, excludeDexes = []) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  if (excludeDexes.length) params.set('excludeDexes', excludeDexes.join(','));
  const url = `${JUPITER_API}/quote?${params}`;

  // Retry on 429 (rate limit) with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000); // FIX 2: 15s timeout
    try {
      const res = await fetch(url, { headers: jupHeaders(), signal: controller.signal });
      if (res.ok) return res.json();
      const err = await res.text();
      if (res.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 2000; // 2s, 4s
        console.log(`[JUP] Rate limited, retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error(`Jupiter quote failed: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Jupiter Swap Transaction ──────────────────────────
async function getSwapTx(quote, userPublicKey, priorityFeeLamports = 50000) {
  const body = JSON.stringify({
    quoteResponse: quote,
    userPublicKey: userPublicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports,
  });

  // Retry on 429 with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000); // FIX 2: 15s timeout
    try {
      const res = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: jupHeaders(),
        body,
        signal: controller.signal,
      });
      if (res.ok) return res.json();
      const err = await res.text();
      if (res.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 2000;
        console.log(`[JUP] Swap tx rate limited, retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error(`Jupiter swap tx failed: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Pump.fun SDK Fallback (Official @pump-fun/pump-sdk + @pump-fun/pump-swap-sdk) ───

// Unified buy: auto-detect bonding curve vs AMM
async function pumpSdkBuy(tokenMint, solAmount, slippageBps = 300) {
  const keypair = getKeypair('default');
  const conn = getConnection();
  const mint = new PublicKey(tokenMint);
  const online = new OnlinePumpSdk(conn);
  const offline = new PumpSdk();

  console.log(`[TRADE] PumpSDK buy ${tokenMint} with ${solAmount} SOL`);

  // Try bonding curve (retry for RPC lag on new tokens)
  let buyState = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      buyState = await online.fetchBuyState(mint, keypair.publicKey);
      break;
    } catch (e) {
      const msg = e.message || '';
      const noBC = msg.includes('Bonding curve account not found') || msg.includes("reading 'eq'");
      if (noBC && attempt < 2) {
        const wait = (attempt + 1) * 3;
        console.log(`[TRADE] Bonding curve not found, retrying in ${wait}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      if (noBC) {
        buyState = null;
        break;
      }
      throw e;
    }
  }

  // Bonding curve found → buy
  if (buyState) {
    const global = await online.fetchGlobal();
    const solLamports = new BN(Math.floor(solAmount * 1e9));
    const tokenAmount = getBuyTokenAmountFromSolAmount(global, buyState.bondingCurve, solLamports);

    const ixs = await offline.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint,
      user: keypair.publicKey,
      solAmount: solLamports,
      amount: tokenAmount,
      slippage: slippageBps / 10000,
    });
    console.log(`[TRADE] PumpSDK bonding curve: ${ixs.length} instructions`);
    return await _sendIxs(conn, keypair, ixs, 'pump-bc');
  }

  // No bonding curve → try PumpSwap AMM
  console.log(`[TRADE] Bonding curve not found, trying PumpSwap AMM...`);
  try {
    return await pumpSwapBuy(tokenMint, solAmount, slippageBps);
  } catch (ammErr) {
    if (ammErr.message?.includes('PumpSwap AMM pool not found')) {
      throw new Error(`Not on Pump.fun (no bonding curve + no AMM pool) | ${ammErr.message}`);
    }
    throw ammErr;
  }
}

// Unified sell: auto-detect bonding curve vs AMM
async function pumpSdkSell(tokenMint, tokenAmount, decimals, slippageBps = 300) {
  const keypair = getKeypair('default');
  const conn = getConnection();
  const mint = new PublicKey(tokenMint);
  const online = new OnlinePumpSdk(conn);
  const offline = new PumpSdk();

  console.log(`[TRADE] PumpSDK sell ${tokenAmount} of ${tokenMint}`);

  // Try bonding curve (retry for RPC lag on new tokens)
  let sellState = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sellState = await online.fetchSellState(mint, keypair.publicKey);
      break;
    } catch (e) {
      const msg = e.message || '';
      const noBC = msg.includes('Bonding curve account not found') || msg.includes("reading 'eq'");
      if (noBC && attempt < 2) {
        const wait = (attempt + 1) * 3;
        console.log(`[TRADE] Bonding curve not found, retrying in ${wait}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      if (noBC) {
        sellState = null;
        break;
      }
      throw e;
    }
  }

  // Bonding curve found → sell
  if (sellState) {
    const global = await online.fetchGlobal();
    const rawAmount = new BN(Math.round(tokenAmount * Math.pow(10, decimals)));
    const minSol = getSellSolAmountFromTokenAmount(global, sellState.bondingCurve, rawAmount);

    const ixs = await offline.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      associatedUserAccountInfo: sellState.associatedUserAccountInfo,
      mint,
      user: keypair.publicKey,
      amount: rawAmount,
      minSolOutput: minSol,
      slippage: slippageBps / 10000,
    });
    console.log(`[TRADE] PumpSDK bonding curve sell: ${ixs.length} instructions`);
    return await _sendIxs(conn, keypair, ixs, 'pump-bc');
  }

  // No bonding curve → try PumpSwap AMM
  console.log(`[TRADE] Bonding curve not found, trying PumpSwap AMM sell...`);
  try {
    return await pumpSwapSell(tokenMint, tokenAmount, decimals, slippageBps);
  } catch (ammErr) {
    if (ammErr.message?.includes('PumpSwap AMM pool not found')) {
      throw new Error(`Not on Pump.fun (no bonding curve + no AMM pool) | ${ammErr.message}`);
    }
    throw ammErr;
  }
}

// PumpSwap AMM buy (graduated tokens)
async function pumpSwapBuy(tokenMint, solAmount, slippageBps = 300) {
  const keypair = getKeypair('default');
  const conn = getConnection();
  const mint = new PublicKey(tokenMint);

  // Find pool — try canonical PDA first, then GMGN fallback
  const poolResult = await findPumpSwapPool(conn, mint);
  if (!poolResult) {
    const pda = canonicalPumpPoolPda(mint);
    const ownerInfo = 'pool not found (PDA + GMGN both failed)';
    throw new Error(`PumpSwap AMM pool not found | pool=${pda.toBase58()} owner=${ownerInfo}`);
  }
  const poolKey = poolResult.poolKey;

  const ammOnline = new OnlinePumpAmmSdk(conn);
  const ammOffline = PUMP_AMM_SDK;
  const swapState = await ammOnline.swapSolanaStateNoPool(poolKey, keypair.publicKey);
  const solLamports = new BN(Math.floor(solAmount * 1e9));
  const slippage = slippageBps / 10000;

  const ixs = await ammOffline.sellBaseInput(swapState, solLamports, slippage);
  console.log(`[TRADE] PumpSwap AMM buy: ${ixs.length} instructions (pool via ${poolResult.source})`);

  return await _sendIxs(conn, keypair, ixs, 'pump-amm');
}

// PumpSwap AMM sell (graduated tokens)
async function pumpSwapSell(tokenMint, tokenAmount, decimals, slippageBps = 300) {
  const keypair = getKeypair('default');
  const conn = getConnection();
  const mint = new PublicKey(tokenMint);

  const poolResult = await findPumpSwapPool(conn, mint);
  if (!poolResult) {
    const pda = canonicalPumpPoolPda(mint);
    const ownerInfo = 'pool not found (PDA + GMGN both failed)';
    throw new Error(`PumpSwap AMM pool not found | pool=${pda.toBase58()} owner=${ownerInfo}`);
  }
  const poolKey = poolResult.poolKey;

  const ammOnline = new OnlinePumpAmmSdk(conn);
  const ammOffline = PUMP_AMM_SDK;
  const swapState = await ammOnline.swapSolanaStateNoPool(poolKey, keypair.publicKey);
  const rawAmount = new BN(Math.round(tokenAmount * Math.pow(10, decimals)));
  const slippage = slippageBps / 10000;

  const ixs = await ammOffline.sellQuoteInput(swapState, rawAmount, slippage);
  console.log(`[TRADE] PumpSwap AMM sell: ${ixs.length} instructions (pool via ${poolResult.source})`);

  return await _sendIxs(conn, keypair, ixs, 'pump-amm');
}

// Shared: build, sign, send, confirm
async function _sendIxs(conn, keypair, ixs, source) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  for (const ix of ixs) tx.add(ix);
  tx.sign(keypair);

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
  console.log(`[TRADE] ${source} TX: ${sig}`);

  const status = await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('confirmTransaction timeout (60s)')), 60_000)),
  ]);

  const err = status?.err || status?.value?.err;
  if (err) throw new Error(`${source} TX failed: ${JSON.stringify(err)}`);

  const details = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (details?.meta?.err) throw new Error(`${source} TX instruction error: ${JSON.stringify(details.meta.err)}`);

  return {
    success: true, signature: sig, source,
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

// ─── Buy Token (SOL → Token) ───────────────────────────
async function buyToken(tokenMint, solAmount, walletLabel = 'default', slippageBps = 300, { _isRetry = false } = {}) {
  try {
    return await _jupiterBuy(tokenMint, solAmount, walletLabel, slippageBps, _isRetry);
  } catch (jupErr) {
    const msg = jupErr.message || '';
    // If pAMM broken → fallback to PumpFun bonding curve
    if (msg.includes('untradeable') || msg.includes('pAMM') || msg.includes('only route') || msg.includes('all routes')) {
      console.log(`[TRADE] Jupiter failed (${msg.slice(0,80)}), falling back to Pump.fun SDK...`);
      return await pumpSdkBuy(tokenMint, solAmount, slippageBps);
    }
    throw jupErr;
  }
}

async function _jupiterBuy(tokenMint, solAmount, walletLabel, slippageBps, _isRetry) {
  const keypair = getKeypair(walletLabel);
  const conn = getConnection();

  const lamports = Math.floor(solAmount * 1e9);
  console.log(`[TRADE] Buy ${tokenMint} with ${solAmount} SOL (slippage ${slippageBps/100}%)`);

  // Get quote — Jupiter handles routing automatically
  const quote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  if (!quote || !quote.outAmount) throw new Error('Empty quote');
  const outAmount = quote.outAmount;
  console.log(`[TRADE] Quote: ${outAmount} tokens (price impact: ${quote.priceImpactPct}%)`);

  // Pre-buy validation: price impact threshold (max 10%)
  const priceImpact = parseFloat(quote.priceImpactPct || '0');
  if (priceImpact > 10) {
    console.error(`[TRADE] REJECTED: price impact ${priceImpact.toFixed(2)}% exceeds 10% threshold for ${tokenMint}`);
    throw new Error(`Price impact too high (${priceImpact.toFixed(2)}%), skipping buy to protect from excessive slippage`);
  }

  // Pre-buy validation: outAmount sanity check — output must be > 0
  const outAmountNum = parseFloat(outAmount || '0');
  if (outAmountNum <= 0) {
    console.error(`[TRADE] REJECTED: quote returned 0 output tokens for ${tokenMint} — token likely dead`);
    throw new Error('Quote output is 0 — token pool likely dead or illiquid');
  }

  // Get decimals from output token
  let decimals = 6;
  try {
    const info = await (require('./wallet').getTokenBalance)(tokenMint, walletLabel);
    if (info.decimals !== undefined && info.decimals >= 0) decimals = info.decimals;
  } catch { console.warn(`[TRADE] Could not fetch decimals for ${tokenMint}, defaulting to 6`); }

  // Get swap transaction
  const swapResult = await getSwapTx(quote, keypair.publicKey);

  // Deserialize and sign
  const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Send — skipPreflight=false lets Solana simulate before submitting, catching error 6001 pre-flight
  let sig;
  let excludedDexes = [];
  try {
    sig = await conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (sendErr) {
    // Extract failed DEX from error message AND logs array
    const errStr = sendErr.message || '';
    const errLogs = Array.isArray(sendErr.logs) ? sendErr.logs.join(' ') : '';
    const combinedErr = errStr + ' ' + errLogs;
    const pammMatch = combinedErr.match(/(pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)/);
    if (pammMatch) excludedDexes.push(pammMatch[1]);
    console.log(`[TRADE] Simulation failed: ${errStr.slice(0, 120)} — retrying${excludedDexes.length ? ` (exclude ${excludedDexes[0].slice(0,8)}..)` : ''}`);

    // Get fresh quote (exclude broken DEX)
    let freshQuote;
    try { freshQuote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps, excludedDexes); } catch {}
    if (!freshQuote || !freshQuote.outAmount) {
      throw new Error('Token untradeable — no alternate route (pAMM pool broken)');
    }

    // Check if fresh quote still routes through broken pAMM
    const freshRouteLabels = (freshQuote.routePlan || []).map(r => (r?.swapInfo?.label || '').toLowerCase()).join(' ');
    if (excludedDexes.length && freshRouteLabels.includes('pump')) {
      // Different Pump.fun program — try it, might work (pAMMBay6 != Pump.fun Amm)
      console.log(`[TRADE] Fresh route uses ${freshQuote.routePlan?.[0]?.swapInfo?.label || 'pump'}, trying swap...`);
      const freshSwapResult = await getSwapTx(freshQuote, keypair.publicKey);
      const freshTxBuf = Buffer.from(freshSwapResult.swapTransaction, 'base64');
      const freshTx = VersionedTransaction.deserialize(freshTxBuf);
      freshTx.sign([keypair]);
      try {
        sig = await conn.sendTransaction(freshTx, { skipPreflight: false, maxRetries: 3 });
      } catch (freshErr) {
        // This route also failed — try Pump.fun SDK as last resort
        const freshErrStr = freshErr.message?.slice(0,80) || 'unknown';
        console.log(`[TRADE] Fresh route also failed: ${freshErrStr}, trying Pump.fun SDK...`);
        try {
          return await pumpSdkBuy(tokenMint, solAmount, slippageBps);
        } catch (psErr) {
          const psErrDetail = psErr.message || 'unknown';
          console.log(`[TRADE] Pump.fun SDK also failed: ${psErrDetail}`);
          // Build detailed error for Telegram notification
          const routeLabels = (freshQuote?.routePlan || []).map(r => r?.swapInfo?.label || '?').join('→');
          const detail = [
            `Routes tried: Jupiter(${routeLabels}) → Pump.fun SDK`,
            `Jupiter err: ${sendErr.message?.slice(0,60) || 'simulation failed'}`,
            `PumpSDK err: ${psErrDetail.slice(0,100)}`,
          ].join('\n');
          throw new Error(`Token untradeable\n${detail}`);
        }
      }
    }

    const freshImpact = parseFloat(freshQuote.priceImpactPct || '0');
    if (freshImpact > 10) {
      throw new Error(`Retry quote price impact too high (${freshImpact.toFixed(2)}%)`);
    }
    const freshSwapResult = await getSwapTx(freshQuote, keypair.publicKey);
    const freshTxBuf = Buffer.from(freshSwapResult.swapTransaction, 'base64');
    const freshTx = VersionedTransaction.deserialize(freshTxBuf);
    freshTx.sign([keypair]);
    sig = await conn.sendTransaction(freshTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
  console.log(`[TRADE] TX sent: ${sig}`);

  // Confirm — FIX 3: 60s timeout to prevent hanging on dead WebSocket
  const status = await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('confirmTransaction timeout (60s)')), 60_000)
    )
  ]);
  console.log(`[TRADE] Confirmed: ${sig}`);

  // Check if TX actually succeeded on-chain
  const err = status?.err || status?.value?.err;
  if (err) {
    const errStr = JSON.stringify(err);
    // On-chain failure (e.g. 6001 ExceededSlippage) — retry ONCE with fresh quote
    if (!_isRetry) {
      console.log(`[TRADE] TX failed on-chain (${errStr}) — retrying with fresh quote`);
      return await buyToken(tokenMint, solAmount, walletLabel, slippageBps, { _isRetry: true });
    }
    console.error(`[TRADE] TX FAILED on-chain (retry exhausted): ${sig}`, errStr);
    throw new Error(`TX failed on-chain: ${errStr}`);
  }

  // Double-check: fetch TX to verify no instruction errors
  const txResult = await conn.getTransaction(sig, { encoding: 'json', maxSupportedTransactionVersion: 0 });
  if (txResult?.meta?.err) {
    console.error(`[TRADE] TX has instruction error: ${sig}`, JSON.stringify(txResult.meta.err));
    throw new Error(`TX instruction error: ${JSON.stringify(txResult.meta.err)}`);
  }

  return {
    success: true,
    signature: sig,
    inputAmount: solAmount,
    outputAmount: outAmount,
    decimals,
    priceImpact: quote.priceImpactPct,
    canonicalMint: quote.outputMint || tokenMint,
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

// ─── Sell Token (Token → SOL) ──────────────────────────
async function sellToken(tokenMint, tokenAmount, decimals, walletLabel = 'default', slippageBps = 300) {
  const keypair = getKeypair(walletLabel);
  const conn = getConnection();

  const rawAmount = Math.round(tokenAmount * Math.pow(10, decimals));
  console.log(`[TRADE] Sell ${tokenAmount} of ${tokenMint} (slippage ${slippageBps/100}%)`);

  // Get quote — Jupiter handles routing automatically
  let quote = await getQuote(tokenMint, SOL_MINT, rawAmount, slippageBps);
  if (!quote || !quote.outAmount) throw new Error('Empty quote');
  let solOut = parseFloat(quote.outAmount) / 1e9;
  console.log(`[TRADE] Quote: ${solOut} SOL (price impact: ${quote.priceImpactPct}%)`);

  // Get swap transaction — retry with lower maxAccounts if encoding overruns
  let swapResult;
  try {
    swapResult = await getSwapTx(quote, keypair.publicKey);
  } catch (txErr) {
    if ((txErr.message || '').includes('encoding overruns')) {
      console.log(`[TRADE] Sell TX too large, retrying with maxAccounts=48...`);
      const params2 = new URLSearchParams({
        inputMint: tokenMint, outputMint: SOL_MINT,
        amount: String(rawAmount), slippageBps: String(slippageBps),
        maxAccounts: '48',
      });
      quote = await fetch(`${JUPITER_API}/quote?${params2}`, { headers: jupHeaders() }).then(r => r.json());
      swapResult = await getSwapTx(quote, keypair.publicKey);
    } else {
      throw txErr;
    }
  }

  // Deserialize and sign
  const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Send
  let sig;
  try {
    sig = await conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (sellErr) {
    const errStr = sellErr.message || '';
    if (errStr.includes('pAMM') || errStr.includes('account required')) {
      console.log(`[TRADE] Sell failed (pAMM broken), trying Pump.fun SDK...`);
      return await pumpSdkSell(tokenMint, tokenAmount, decimals, slippageBps);
    }
    throw sellErr;
  }
  console.log(`[TRADE] TX sent: ${sig}`);

  // Confirm — FIX 3: 60s timeout to prevent hanging on dead WebSocket
  const status = await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('confirmTransaction timeout (60s)')), 60_000)
    )
  ]);
  console.log(`[TRADE] Confirmed: ${sig}`);

  // Check if TX actually succeeded on-chain
  const err = status?.err || status?.value?.err;
  if (err) {
    console.error(`[TRADE] Sell TX FAILED on-chain: ${sig}`, JSON.stringify(err));
    throw new Error(`Sell TX failed on-chain: ${JSON.stringify(err)}`);
  }

  // Double-check: fetch TX to verify no instruction errors
  const txResult = await conn.getTransaction(sig, { encoding: 'json', maxSupportedTransactionVersion: 0 });
  if (txResult?.meta?.err) {
    console.error(`[TRADE] Sell TX has instruction error: ${sig}`, JSON.stringify(txResult.meta.err));
    throw new Error(`Sell TX instruction error: ${JSON.stringify(txResult.meta.err)}`);
  }

  return {
    success: true,
    signature: sig,
    inputAmount: tokenAmount,
    outputSol: solOut,
    priceImpact: quote.priceImpactPct,
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

// ─── Sell All of a Token ───────────────────────────────
async function sellAll(tokenMint, walletLabel = 'default', slippageBps = 500) {
  const { getTokenBalance } = require('./wallet');
  const bal = await getTokenBalance(tokenMint, walletLabel);
  if (bal.amount <= 0) throw new Error('No tokens to sell');
  const realMint = bal.canonicalMint || tokenMint;
  return sellToken(realMint, bal.amount, bal.decimals, walletLabel, slippageBps);
}

module.exports = {
  buyToken, sellToken, sellAll,
  getQuote, SOL_MINT,
};
