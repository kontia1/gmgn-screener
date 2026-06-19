/**
 * Trading Module — Jupiter V6 swap (buy/sell)
 * SOL ↔ SPL Token
 * Uses Jupiter API key for premium routing + higher rate limits
 */
const { Transaction, VersionedTransaction } = require('@solana/web3.js');
const { getKeypair, getConnection } = require('./wallet');

const JUPITER_API = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
const JUPITER_KEY = process.env.JUPITER_API_KEY || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Build headers with API key if available
function jupHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (JUPITER_KEY) h['x-api-key'] = JUPITER_KEY;
  return h;
}

// ─── Jupiter Quote ─────────────────────────────────────
// maxAccounts omitted = Jupiter determines optimal routing automatically
async function getQuote(inputMint, outputMint, amount, slippageBps = 300) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  const url = `${JUPITER_API}/quote?${params}`;

  // Retry on 429 (rate limit) with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: jupHeaders() });
    if (res.ok) return res.json();
    const err = await res.text();
    if (res.status === 429 && attempt < 2) {
      const wait = (attempt + 1) * 2000; // 2s, 4s
      console.log(`[JUP] Rate limited, retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Jupiter quote failed: ${err}`);
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
    const res = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: jupHeaders(),
      body,
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
  }
}

// ─── Buy Token (SOL → Token) ───────────────────────────
async function buyToken(tokenMint, solAmount, walletLabel = 'default', slippageBps = 300, { _isRetry = false } = {}) {
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
  try {
    sig = await conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (sendErr) {
    // Simulation failed — retry ONCE with a fresh quote (pool state may have changed)
    console.log(`[TRADE] Simulation/rejection failed: ${sendErr.message} — retrying with fresh quote`);
    const freshQuote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
    if (!freshQuote || !freshQuote.outAmount) throw new Error('Fresh quote empty after retry');
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

  // Confirm
  const status = await conn.confirmTransaction(sig, 'confirmed');
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
  const quote = await getQuote(tokenMint, SOL_MINT, rawAmount, slippageBps);
  if (!quote || !quote.outAmount) throw new Error('Empty quote');
  const solOut = parseFloat(quote.outAmount) / 1e9;
  console.log(`[TRADE] Quote: ${solOut} SOL (price impact: ${quote.priceImpactPct}%)`);

  // Get swap transaction
  const swapResult = await getSwapTx(quote, keypair.publicKey);

  // Deserialize and sign
  const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Send
  const sig = await conn.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log(`[TRADE] TX sent: ${sig}`);

  // Confirm
  const status = await conn.confirmTransaction(sig, 'confirmed');
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
