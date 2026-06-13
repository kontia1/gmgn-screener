/**
 * close-rugs.js — Close dead/rugged token positions + recover rent
 * 
 * Usage: node scripts/close-rugs.js [--dry-run]
 * 
 * - Sells orphaned wallet tokens via Jupiter
 * - Closes dead token accounts to recover rent (~0.002 SOL each)
 * - Closes rugged open positions
 */

const positions = require('../src/positions');
const { getQuote, SOL_MINT, sellAll } = require('../src/trading');
const wallet = require('../src/wallet');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const [walletTokens, open] = await Promise.all([
    wallet.getAllTokenBalances(),
    Promise.resolve(positions.getOpenPositions()),
  ]);

  const openMints = new Set(open.map(p => p.tokenMint));
  const orphaned = walletTokens.filter(t => !openMints.has(t.mint) && t.amount > 0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Rug Scanner — ${open.length} positions + ${orphaned.length} wallet tokens`);
  if (DRY_RUN) console.log(`  ⚠️  DRY RUN (no changes)`);
  console.log(`${'='.repeat(60)}\n`);

  let sold = 0, skipped = 0, errors = 0, rentRecovered = 0;

  // 1. Orphaned wallet tokens
  for (const t of orphaned) {
    const short = t.mint.slice(0, 8);
    try {
      const rawAmount = Math.floor(t.amount * Math.pow(10, t.decimals));
      const quote = await getQuote(t.mint, SOL_MINT, rawAmount, 500);
      const solOut = parseFloat(quote.outAmount) / 1e9;

      if (solOut < 0.0001) {
        console.log(`⏭️  ${short} — dust (${solOut.toFixed(6)} SOL)`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`💰 ${short} — would sell (${solOut.toFixed(4)} SOL)`);
      } else {
        const result = await sellAll(t.mint, 'default', 500);
        console.log(`✅ ${short} — sold for ${solOut.toFixed(4)} SOL`);
      }
      sold++;
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NO_ROUTES_FOUND') || msg.includes('No routes found')) {
        // Close account to recover rent
        if (DRY_RUN) {
          console.log(`💀 ${short} — dead, would close account (~0.002 SOL rent)`);
        } else {
          try {
            await wallet.closeTokenAccount(t.mint);
            console.log(`💀 ${short} — dead, account closed (rent recovered)`);
            rentRecovered++;
          } catch (closeErr) {
            console.log(`⚠️  ${short} — dead, close failed: ${closeErr.message.slice(0, 60)}`);
            errors++;
          }
        }
        sold++;
      } else {
        console.log(`⚠️  ${short} — ${msg.slice(0, 60)}`);
        errors++;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 2. Open positions
  for (const pos of open) {
    const short = pos.symbol;
    try {
      const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      const solOut = parseFloat(quote.outAmount) / 1e9;
      const pnlPct = pos.solSpent > 0 ? ((solOut - pos.solSpent) / pos.solSpent * 100) : -100;

      if (pnlPct <= -80) {
        if (DRY_RUN) {
          console.log(`🔴 ${short} — rug (${pnlPct.toFixed(1)}%), would sell`);
        } else {
          try {
            const result = await sellAll(pos.tokenMint, 'default', 500);
            positions.closePosition(pos.tokenMint, result.outputSol || 0, result.signature || 'none', 'rug_scan');
            console.log(`🔴 ${short} — sold (${pnlPct.toFixed(1)}%)`);
          } catch {
            positions.closePosition(pos.tokenMint, 0, 'none', 'rug_scan');
            console.log(`🔴 ${short} — sell failed, position closed`);
          }
        }
        sold++;
      } else {
        console.log(`🟢 ${short} — healthy (${pnlPct.toFixed(1)}%)`);
        skipped++;
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NO_ROUTES_FOUND')) {
        positions.closePosition(pos.tokenMint, 0, 'none', 'rug_scan_dead');
        console.log(`💀 ${short} — dead, position closed`);
        sold++;
      } else {
        console.log(`⚠️  ${short} — ${msg.slice(0, 60)}`);
        errors++;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Results: ${sold} sold/closed | ${skipped} skipped | ${errors} errors`);
  if (rentRecovered) console.log(`  Rent recovered: ${rentRecovered} accounts (~${(rentRecovered * 0.002).toFixed(3)} SOL)`);
  if (DRY_RUN) console.log(`  Run without --dry-run to execute`);
  console.log(`${'─'.repeat(60)}\n`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
