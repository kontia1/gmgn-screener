/**
 * PumpFun Bonding Curve — Direct Buy/Sell
 * Fallback when Jupiter pAMM routing fails
 */
const {
  Transaction, VersionedTransaction, TransactionInstruction,
  PublicKey, Keypair, AddressLookupTableAccount,
} = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const { getKeypair, getConnection } = require('../wallet');
const {
  PUMP_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, RENT_PROGRAM,
  BUY_DISCRIMINATOR, SELL_DISCRIMINATOR,
  findGlobalPDA, findBondingCurvePDA, findAssociatedBondingCurve,
  findCreatorVault, findEventAuthority, findGlobalVolumeAccumulator,
  findUserVolumeAccumulator, findFeeConfig, FEE_PROGRAM,
} = require('./constants');

/**
 * Get bonding curve account data (creator, virtual reserves)
 */
async function getBondingCurveData(mint) {
  const conn = getConnection();
  const bondingCurve = findBondingCurvePDA(mint);
  const accountInfo = await conn.getAccountInfo(bondingCurve);
  if (!accountInfo || !accountInfo.data) return null;

  const data = accountInfo.data;
  // Bonding curve layout (from IDL):
  // 8 bytes discriminator
  // 1 byte virtual_token_reserves (u64) — 8 bytes
  // 2: virtual_sol_reserves (u64) — 8 bytes
  // 3: real_token_reserves (u64) — 8 bytes
  // 4: real_sol_reserves (u64) — 8 bytes
  // 5: token_total_supply (u64) — 8 bytes
  // 6: complete (bool) — 1 byte
  const virtualTokenReserves = data.readBigUInt64LE(8);
  const virtualSolReserves = data.readBigUInt64LE(16);
  const realTokenReserves = data.readBigUInt64LE(24);
  const realSolReserves = data.readBigUInt64LE(32);
  const tokenTotalSupply = data.readBigUInt64LE(40);
  const complete = data[48] === 1;

  // Creator is at offset 49 (after all the above fields)
  const creator = new PublicKey(data.slice(49, 81));

  return {
    bondingCurve,
    creator,
    virtualTokenReserves: Number(virtualTokenReserves),
    virtualSolReserves: Number(virtualSolReserves),
    realTokenReserves: Number(realTokenReserves),
    realSolReserves: Number(realSolReserves),
    tokenTotalSupply: Number(tokenTotalSupply),
    complete,
  };
}

/**
 * Calculate expected tokens out for given SOL input (constant product formula)
 */
function calculateTokensOut(solAmount, curveData) {
  const solLamports = solAmount * 1e9;
  const { virtualSolReserves, virtualTokenReserves } = curveData;
  // constant product: tokensOut = tokenReserves - (solReserves * tokenReserves) / (solReserves + solIn)
  const tokensOut = virtualTokenReserves - Math.floor(
    (BigInt(virtualSolReserves) * BigInt(virtualTokenReserves)) / BigInt(virtualSolReserves + solLamports)
  );
  return tokensOut;
}

/**
 * Buy token directly via PumpFun bonding curve
 * @param {string} tokenMint - SPL token mint address
 * @param {number} solAmount - SOL amount to spend
 * @param {number} slippageBps - slippage tolerance (default 500 = 5%)
 * @returns {object} - { success, signature, outputAmount, ... }
 */
async function pumpFunBuy(tokenMint, solAmount, slippageBps = 500) {
  const conn = getConnection();
  const keypair = getKeypair();
  const mint = new PublicKey(tokenMint);
  const user = keypair.publicKey;

  console.log(`[PUMP] Buy ${tokenMint} with ${solAmount} SOL (slippage ${slippageBps/100}%)`);

  // Get bonding curve data
  const curveData = await getBondingCurveData(mint);
  if (!curveData) throw new Error('Bonding curve not found — token may have migrated to AMM');
  if (curveData.complete) throw new Error('Bonding curve complete — token migrated to AMM, use Jupiter');

  // Calculate expected output
  const expectedTokens = calculateTokensOut(solAmount, curveData);
  const maxSolLamports = Math.floor(solAmount * 1e9 * (1 + slippageBps / 10000));
  console.log(`[PUMP] Expected ~${expectedTokens} tokens, max SOL: ${maxSolLamports / 1e9}`);

  // Derive accounts
  const bondingCurve = curveData.bondingCurve;
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, user);
  const creatorVault = findCreatorVault(curveData.creator);
  const eventAuthority = findEventAuthority();
  const globalVolumeAccumulator = findGlobalVolumeAccumulator();
  const userVolumeAccumulator = findUserVolumeAccumulator(user);
  const feeConfig = findFeeConfig();

  // Find fee recipient (first writable account that's not bonding_curve)
  // PumpFun fee recipient is typically a well-known address
  const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ6NKaA5Fmav');

  // Build instruction data: discriminator + amount(u64) + max_sol_cost(u64) + track_volume
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(expectedTokens), 8);
  data.writeBigUInt64LE(BigInt(maxSolLamports), 16);
  data[24] = 0; // track_volume = false (OptionBool::None)

  // Build accounts list (from IDL buy instruction)
  const accounts = [
    { pubkey: findGlobalPDA(),               isSigner: false, isWritable: false }, // [0] global
    { pubkey: FEE_RECIPIENT,                 isSigner: false, isWritable: true  }, // [1] fee_recipient
    { pubkey: mint,                          isSigner: false, isWritable: false }, // [2] mint
    { pubkey: bondingCurve,                  isSigner: false, isWritable: true  }, // [3] bonding_curve
    { pubkey: associatedBondingCurve,        isSigner: false, isWritable: true  }, // [4] associated_bonding_curve
    { pubkey: associatedUser,                isSigner: false, isWritable: true  }, // [5] associated_user
    { pubkey: user,                          isSigner: true,  isWritable: true  }, // [6] user
    { pubkey: SYSTEM_PROGRAM,                isSigner: false, isWritable: false }, // [7] system_program
    { pubkey: TOKEN_PROGRAM,                 isSigner: false, isWritable: false }, // [8] token_program
    { pubkey: creatorVault,                  isSigner: false, isWritable: true  }, // [9] creator_vault
    { pubkey: eventAuthority,                isSigner: false, isWritable: false }, // [10] event_authority
    { pubkey: PUMP_PROGRAM,                  isSigner: false, isWritable: false }, // [11] program
    { pubkey: globalVolumeAccumulator,       isSigner: false, isWritable: false }, // [12] global_volume_accumulator
    { pubkey: userVolumeAccumulator,         isSigner: false, isWritable: true  }, // [13] user_volume_accumulator
    { pubkey: feeConfig,                     isSigner: false, isWritable: false }, // [14] fee_config
    { pubkey: FEE_PROGRAM,                   isSigner: false, isWritable: false }, // [15] fee_program
  ];

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: accounts,
    data,
  });

  // Build and send transaction
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = user;
  tx.sign(keypair);

  const sig = await conn.sendTransaction(tx, [keypair], {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[PUMP] TX sent: ${sig}`);

  // Confirm
  const status = await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('confirm timeout (60s)')), 60_000)),
  ]);
  const err = status?.err || status?.value?.err;
  if (err) throw new Error(`PumpFun TX failed on-chain: ${JSON.stringify(err)}`);

  console.log(`[PUMP] Confirmed: ${sig}`);
  return {
    success: true,
    signature: sig,
    inputAmount: solAmount,
    outputAmount: String(expectedTokens),
    explorer: `https://solscan.io/tx/${sig}`,
    source: 'pumpfun-bonding-curve',
  };
}

/**
 * Sell token directly via PumpFun bonding curve
 */
async function pumpFunSell(tokenMint, tokenAmount, decimals = 6, slippageBps = 500) {
  const conn = getConnection();
  const keypair = getKeypair();
  const mint = new PublicKey(tokenMint);
  const user = keypair.publicKey;

  console.log(`[PUMP] Sell ${tokenAmount} of ${tokenMint}`);

  const curveData = await getBondingCurveData(mint);
  if (!curveData) throw new Error('Bonding curve not found');

  // Calculate expected SOL out
  const rawAmount = Math.floor(tokenAmount * Math.pow(10, decimals));
  const { virtualSolReserves, virtualTokenReserves } = curveData;
  const expectedSol = Math.floor(
    (BigInt(virtualSolReserves) * BigInt(rawAmount)) / BigInt(virtualTokenReserves + rawAmount)
  );
  const minSolOutput = Math.floor(Number(expectedSol) * (1 - slippageBps / 10000));
  console.log(`[PUMP] Expected ~${Number(expectedSol)/1e9} SOL, min: ${minSolOutput/1e9}`);

  const bondingCurve = curveData.bondingCurve;
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, user);
  const creatorVault = findCreatorVault(curveData.creator);
  const eventAuthority = findEventAuthority();
  const feeConfig = findFeeConfig();
  const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ6NKaA5Fmav');

  // Build instruction data
  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(rawAmount), 8);
  data.writeBigUInt64LE(BigInt(minSolOutput), 16);

  const accounts = [
    { pubkey: findGlobalPDA(),               isSigner: false, isWritable: false },
    { pubkey: FEE_RECIPIENT,                 isSigner: false, isWritable: true  },
    { pubkey: mint,                          isSigner: false, isWritable: false },
    { pubkey: bondingCurve,                  isSigner: false, isWritable: true  },
    { pubkey: associatedBondingCurve,        isSigner: false, isWritable: true  },
    { pubkey: associatedUser,                isSigner: false, isWritable: true  },
    { pubkey: user,                          isSigner: true,  isWritable: true  },
    { pubkey: SYSTEM_PROGRAM,                isSigner: false, isWritable: false },
    { pubkey: creatorVault,                  isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM,                 isSigner: false, isWritable: false },
    { pubkey: eventAuthority,                isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM,                  isSigner: false, isWritable: false },
    { pubkey: feeConfig,                     isSigner: false, isWritable: false },
    { pubkey: FEE_PROGRAM,                   isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: accounts,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = user;
  tx.sign(keypair);

  const sig = await conn.sendTransaction(tx, [keypair], {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[PUMP] TX sent: ${sig}`);

  const status = await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('confirm timeout (60s)')), 60_000)),
  ]);
  const err = status?.err || status?.value?.err;
  if (err) throw new Error(`PumpFun sell TX failed: ${JSON.stringify(err)}`);

  console.log(`[PUMP] Confirmed: ${sig}`);
  return {
    success: true,
    signature: sig,
    inputAmount: tokenAmount,
    explorer: `https://solscan.io/tx/${sig}`,
    source: 'pumpfun-bonding-curve',
  };
}

/**
 * Check if token is still on bonding curve (not migrated to AMM)
 */
async function isOnBondingCurve(tokenMint) {
  try {
    const mint = new PublicKey(tokenMint);
    const curveData = await getBondingCurveData(mint);
    return !!(curveData && !curveData.complete);
  } catch { return false; }
}

module.exports = {
  pumpFunBuy,
  pumpFunSell,
  isOnBondingCurve,
  getBondingCurveData,
  calculateTokensOut,
};
