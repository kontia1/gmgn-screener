/**
 * Wallet Management — import, create, getBalance, getTokenBalance
 * Storage: config/wallet.json (NEVER commit)
 */
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const fs = require('fs');
const path = require('path');

const WALLET_FILE = path.join(__dirname, '..', 'config', 'wallet.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

// ─── Helpers ───────────────────────────────────────────
function loadEnv() {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  } catch { return {}; }
}

function getRpcUrl() {
  const env = loadEnv();
  return env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

function getConnection() {
  return new Connection(getRpcUrl(), 'confirmed');
}

// ─── Wallet Storage ────────────────────────────────────
function loadWalletStore() {
  // Env var takes precedence (for portability)
  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      const decoded = bs58.decode(process.env.WALLET_PRIVATE_KEY.trim());
      if (decoded.length === 64) {
        const kp = Keypair.fromSecretKey(decoded);
        return {
          wallets: {
            env: {
              publicKey: kp.publicKey.toBase58(),
              secretKey: bs58.encode(kp.secretKey),
              addedAt: new Date().toISOString(),
              source: 'env',
            }
          },
          _activeLabel: 'env',
          _keypair: kp,
        };
      }
    } catch (e) { console.error('[WALLET] Invalid WALLET_PRIVATE_KEY:', e.message); }
  }
  // Fallback to file
  try {
    const store = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    // Reconstruct _keypair for the active wallet
    const active = store._activeLabel || Object.keys(store.wallets)[0];
    if (active && store.wallets[active]) {
      try {
        const decoded = bs58.decode(store.wallets[active].secretKey);
        if (decoded.length === 64) store._keypair = Keypair.fromSecretKey(decoded);
      } catch {}
    }
    return store;
  }
  catch { return { wallets: {} }; }
}

function saveWalletStore(store) {
  const dir = path.dirname(WALLET_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WALLET_FILE, JSON.stringify(store, null, 2));
}

// ─── Import Wallet ─────────────────────────────────────
// Supports: base58 private key, JSON array (Solana CLI format), seed phrase
function importWallet(input, label = 'default') {
  let keypair;

  // Try base58 private key
  try {
    const decoded = bs58.decode(input.trim());
    if (decoded.length === 64) {
      keypair = Keypair.fromSecretKey(decoded);
    }
  } catch {}

  // Try JSON array [1,2,3,...]
  if (!keypair) {
    try {
      const arr = JSON.parse(input.trim());
      if (Array.isArray(arr) && arr.length === 64) {
        keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
      }
    } catch {}
  }

  // Try base58 of 32-byte seed (some wallets export seed only)
  if (!keypair) {
    try {
      const decoded = bs58.decode(input.trim());
      if (decoded.length === 32) {
        keypair = Keypair.fromSeed(decoded);
      }
    } catch {}
  }

  if (!keypair) throw new Error('Invalid wallet input. Supported: base58 private key, JSON array [1,2,...,64]');

  const store = loadWalletStore();
  store.wallets[label] = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    addedAt: new Date().toISOString(),
  };
  saveWalletStore(store);

  return {
    label,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
  };
}

// ─── Create New Wallet ─────────────────────────────────
function createWallet(label = 'default') {
  const keypair = Keypair.generate();
  const store = loadWalletStore();
  store.wallets[label] = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    addedAt: new Date().toISOString(),
  };
  saveWalletStore(store);

  return {
    label,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
  };
}

// ─── Get Keypair ───────────────────────────────────────
function getKeypair(label = 'default') {
  const store = loadWalletStore();
  // If _keypair already cached (from env), use it
  if (store._keypair && (label === 'default' || label === store._activeLabel)) {
    return store._keypair;
  }
  // Use active label if default not found
  if (!store.wallets[label] && store._activeLabel) {
    label = store._activeLabel;
  }
  const w = store.wallets[label];
  if (!w) throw new Error(`Wallet '${label}' not found. Use /wallet import <key>`);
  return Keypair.fromSecretKey(bs58.decode(w.secretKey));
}

function getPublicKey(label = 'default') {
  return getKeypair(label).publicKey;
}

// ─── List Wallets ──────────────────────────────────────
function listWallets() {
  const store = loadWalletStore();
  return Object.entries(store.wallets).map(([label, w]) => ({
    label,
    publicKey: w.publicKey,
    addedAt: w.addedAt,
  }));
}

// ─── Remove Wallet ─────────────────────────────────────
function removeWallet(label) {
  const store = loadWalletStore();
  if (!store.wallets[label]) throw new Error(`Wallet '${label}' not found`);
  delete store.wallets[label];
  saveWalletStore(store);
  return true;
}

// ─── Balance ───────────────────────────────────────────
async function getSolBalance(label = 'default') {
  const conn = getConnection();
  const pubkey = getPublicKey(label);
  const lamports = await conn.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

async function getTokenBalance(mintAddress, label = 'default') {
  const conn = getConnection();
  const owner = getPublicKey(label);

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('getTokenBalance timeout')), 15000));
  const fetch = async () => {
    const [acc1, acc2] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    const allAccounts = [...acc1.value, ...acc2.value];

    const lower = mintAddress.toLowerCase();
    for (const { account } of allAccounts) {
      const info = account.data.parsed.info;
      if (info.mint.toLowerCase() === lower) {
        return {
          amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmount,
          canonicalMint: info.mint,  // on-chain case
        };
      }
    }
    return { amount: 0, decimals: 0, uiAmount: 0, canonicalMint: mintAddress };
  };

  return Promise.race([fetch(), timeout]);
}

// ─── All Token Accounts (including zero balance) ───────
// Returns account pubkey + mint + balance — used for closing empty accounts
async function getAllTokenAccounts(label = 'default') {
  const conn = getConnection();
  const owner = getPublicKey(label);

  const [acc1, acc2] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const allAccounts = [...acc1.value, ...acc2.value];

  return allAccounts.map(({ pubkey, account }) => {
    const info = account.data.parsed.info;
    const rawBalance = BigInt(info.tokenAmount.amount);
    return {
      pubkey: pubkey.toBase58(),
      mint: info.mint,
      amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
      decimals: info.tokenAmount.decimals,
      rawBalance,
      programId: account.owner.toBase58(),
      isZero: rawBalance === 0n,
    };
  });
}

// ─── All Token Balances ────────────────────────────────
async function getAllTokenBalances(label = 'default') {
  const conn = getConnection();
  const owner = getPublicKey(label);

  const [acc1, acc2] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const allAccounts = [...acc1.value, ...acc2.value];

  return allAccounts
    .map(({ account }) => {
      const info = account.data.parsed.info;
      return {
        mint: info.mint,
        amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
        decimals: info.tokenAmount.decimals,
      };
    })
    .filter(t => t.amount > 0);
}

// ─── Close Token Account (recover rent) ─────────────────
// Burns remaining tokens (if any) then closes the account
async function closeTokenAccount(mintAddress, walletLabel = 'default') {
  const { createCloseAccountInstruction, createBurnInstruction, getAssociatedTokenAddressSync } = require('@solana/spl-token');
  const { Transaction } = require('@solana/web3.js');

  const keypair = getKeypair(walletLabel);
  const conn = getConnection();
  const owner = keypair.publicKey;

  // Find the token account (try both programs)
  const [acc1, acc2] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const allAccounts = [...acc1.value, ...acc2.value];
  const tokenAccount = allAccounts.find(a => a.account.data.parsed.info.mint === mintAddress);

  if (!tokenAccount) throw new Error('Token account not found');

  const info = tokenAccount.account.data.parsed.info;
  const balance = parseFloat(info.tokenAmount.uiAmountString || '0');
  const decimals = info.tokenAmount.decimals;
  const rawBalance = BigInt(info.tokenAmount.amount);
  const programId = tokenAccount.account.owner; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
  const mint = new PublicKey(mintAddress);

  const instructions = [];

  // Burn remaining tokens if any
  if (rawBalance > 0n) {
    instructions.push(
      createBurnInstruction(
        tokenAccount.pubkey,
        mint,
        owner,
        rawBalance,
        [],
        programId,
      )
    );
  }

  // Close account
  instructions.push(
    createCloseAccountInstruction(
      tokenAccount.pubkey,
      owner,
      owner,
      [],
      programId,
    )
  );

  const tx = new Transaction().add(...instructions);
  const sig = await conn.sendTransaction(tx, [keypair]);
  await conn.confirmTransaction(sig, 'confirmed');

  return {
    success: true,
    signature: sig,
    burned: balance,
    program: programId.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl-token',
  };
}

// ─── Close All Zero-Balance Token Accounts ──────────────
// Recovers rent from empty token accounts
async function closeZeroBalanceAccounts(walletLabel = 'default') {
  const { createCloseAccountInstruction } = require('@solana/spl-token');
  const { Transaction } = require('@solana/web3.js');

  const keypair = getKeypair(walletLabel);
  const conn = getConnection();
  const owner = keypair.publicKey;

  const [acc1, acc2] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const zeroBalance = [...acc1.value, ...acc2.value].filter(a => {
    const info = a.account.data.parsed.info;
    return BigInt(info.tokenAmount.amount) === 0n;
  });

  if (!zeroBalance.length) return { closed: 0, recovered: 0 };

  // Batch close (up to 10 per transaction)
  let closed = 0;
  for (let i = 0; i < zeroBalance.length; i += 10) {
    const batch = zeroBalance.slice(i, i + 10);
    const tx = new Transaction();
    for (const acc of batch) {
      tx.add(
        createCloseAccountInstruction(
          acc.pubkey,
          owner,
          owner,
          [],
          acc.account.owner,
        )
      );
    }
    const sig = await conn.sendTransaction(tx, [keypair]);
    await conn.confirmTransaction(sig, 'confirmed');
    closed += batch.length;
  }

  return { closed, recovered: closed * 0.002 };
}

module.exports = {
  importWallet, createWallet, getKeypair, getPublicKey,
  listWallets, removeWallet,
  getSolBalance, getTokenBalance, getAllTokenBalances, getAllTokenAccounts,
  closeTokenAccount, closeZeroBalanceAccounts,
  getConnection, loadWalletStore, saveWalletStore,
};
