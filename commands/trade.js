/**
 * Trade Commands — Telegram bot command handlers
 * /buy, /sell, /sellall, /pnl, /positions, /remove, /wallet, /config
 */
const { tgApi } = require('../lib/shared');
const wallet = require('../src/wallet');
const trading = require('../src/trading');
const positions = require('../src/positions');
const autotrade = require('../src/autotrade');
const { positionButtons, configButtons, allPositionsButtons, mainMenu } = require('../src/buttons');

// Resolve mint to canonical case from positions store (base58 is case-sensitive)
function resolveMint(inputMint) {
  const all = positions.loadPositions();
  const lower = inputMint.toLowerCase();
  for (const key of Object.keys(all)) {
    if (key.toLowerCase() === lower) return key;
  }
  return inputMint; // fallback to user input
}

// ─── /wallet — manage wallets ──────────────────────────
async function handleWallet(chatId, args) {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'info') {
    try {
      const sol = await wallet.getSolBalance();
      const tokens = await wallet.getAllTokenBalances();
      const pubs = wallet.listWallets();
      const pub = pubs[0]?.publicKey || 'No wallet';

      const lines = [
        `💼 <b>Wallet</b>`,
        ``,
        `🔑 <code>${pub}</code>`,
        `💰 SOL: <b>${sol.toFixed(4)}</b>`,
        `📦 Tokens: <b>${tokens.length}</b>`,
      ];

      if (tokens.length > 0 && tokens.length <= 10) {
        lines.push('');
        for (const t of tokens) {
          lines.push(`• <code>${t.mint}</code>: ${t.amount}`);
        }
      }

      await tgApi('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  if (sub === 'import') {
    const key = args.slice(1).join(' ');
    if (!key) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /wallet import <base58_key_or_json_array>', parse_mode: 'HTML' });
      return;
    }
    try {
      const w = wallet.importWallet(key, 'default');
      const sol = await wallet.getSolBalance();
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Wallet imported</b>\n\n🔑 <code>${w.publicKey}</code>\n💰 SOL: ${sol.toFixed(4)}`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  if (sub === 'new') {
    try {
      const w = wallet.createWallet('default');
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>New wallet created</b>\n\n🔑 <code>${w.publicKey}</code>\n\n⚠️ Save this key securely:\n<code>${w.secretKey}</code>`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  if (sub === 'delete' || sub === 'del' || sub === 'remove') {
    const label = args[1] || 'default';
    try {
      wallet.removeWallet(label);
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ Wallet '${label}' deleted`, parse_mode: 'HTML' });
    } catch (e) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML' });
    }
    return;
  }

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `💼 <b>Wallet Commands</b>\n\n/wallet — Show info\n/wallet import &lt;key&gt; — Import\n/wallet new — Create\n/wallet delete — Delete`,
    parse_mode: 'HTML',
  });
}

// ─── /buy — buy token ──────────────────────────────────
async function handleBuy(chatId, args) {
  if (args.length < 1) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Usage: /buy <token_mint> [sol_amount]\n\nExample: /buy ABC...xyz 0.1',
      parse_mode: 'HTML',
    });
    return;
  }

  const mint = args[0];
  const amount = parseFloat(args[1]) || 0.05;

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: `⏳ Buying with ${amount} SOL...`, parse_mode: 'HTML' });

    const result = await trading.buyToken(mint, amount);

    if (result.success) {
      const realMint = result.canonicalMint || mint;
      const bal = await wallet.getTokenBalance(realMint);
      const tokenAmount = bal.amount > 0 ? bal.amount : (parseFloat(result.outputAmount || '0') / Math.pow(10, result.decimals || 6));
      if (tokenAmount <= 0) throw new Error('Got 0 tokens from buy');
      const entryPrice = amount / tokenAmount;

      positions.openPosition(realMint, realMint.slice(0, 6), entryPrice, amount, tokenAmount, bal.decimals || result.decimals || 6, result.signature);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Buy Success</b>\n\n` +
          `💰 Spent: ${amount} SOL\n` +
          `📦 Got: ${bal.amount.toFixed(2)} tokens\n` +
          `📊 Price Impact: ${result.priceImpact}%\n\n` +
          `🔗 <a href="${result.explorer}">TX</a>`,
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    console.error('[TRADE] Buy failed:', e.message, e.cause?.code || '');
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Buy failed: ${e.message}`, parse_mode: 'HTML' });
  }
}

// ─── /sell — sell percentage of token ──────────────────
async function handleSell(chatId, args) {
  if (args.length < 1) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Usage: /sell <token_mint> [percentage=100]\n\nExample: /sell ABC...xyz 50',
      parse_mode: 'HTML',
    });
    return;
  }

  const mint = resolveMint(args[0]);
  const pct = parseFloat(args[1]) || 100;

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: `⏳ Selling ${pct}%...`, parse_mode: 'HTML' });

    const bal = await wallet.getTokenBalance(mint);
    if (bal.amount <= 0) throw new Error('No tokens found');

    const sellAmount = bal.amount * (pct / 100);
    const result = await trading.sellToken(mint, sellAmount, bal.decimals, 'default', 500);

    if (result.success) {
      // Update position tracking
      const pos = positions.getPosition(mint);
      if (pos) {
        if (pct >= 100) {
          positions.closePosition(mint, result.outputSol, result.signature, 'manual');
        } else {
          positions.recordPartialSell(mint, sellAmount, result.outputSol, result.signature, `manual_${pct}pct`);
        }
      }

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Sell Success</b>\n\n` +
          `📦 Sold: ${sellAmount.toFixed(2)} tokens (${pct}%)\n` +
          `💰 Got: ${result.outputSol.toFixed(4)} SOL\n` +
          `📊 Price Impact: ${result.priceImpact}%\n\n` +
          `🔗 <a href="${result.explorer}">TX</a>`,
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Sell failed: ${e.message}`, parse_mode: 'HTML' });
  }
}

// ─── /sellall — sell entire position ───────────────────
async function handleSellAll(chatId, args) {
  if (!args[0]) {
    await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /sellall <token_mint>', parse_mode: 'HTML' });
    return;
  }

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: `⏳ Selling all...`, parse_mode: 'HTML' });
    const mint = resolveMint(args[0]);
    const result = await trading.sellAll(mint, 'default', 500);

    if (result.success) {
      const pos = positions.getPosition(mint);
      if (pos) positions.closePosition(mint, result.outputSol, result.signature, 'manual');

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Sell All Success</b>\n\n💰 Got: ${result.outputSol.toFixed(4)} SOL\n🔗 <a href="${result.explorer}">TX</a>`,
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ ${e.message}`, parse_mode: 'HTML' });
  }
}

// ─── /positions — show open positions ──────────────────
async function handlePositions(chatId) {
  const open = positions.getOpenPositions();
  if (!open.length) {
    await tgApi('sendMessage', { chat_id: chatId, text: '📭 No open positions.', parse_mode: 'HTML' });
    return;
  }

  const { getQuote, SOL_MINT } = require('../src/trading');
  const gmgn = require('../lib/shared');
  const lines = [`📋 <b>Open Positions</b> — ${open.length}\n`];
  for (const pos of open) {
    // Use Jupiter quote for accurate PNL (same as monitor)
    let currentPrice = 0;
    let quoteSolOut = 0;
    try {
      const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      quoteSolOut = parseFloat(quote.outAmount) / 1e9;
      currentPrice = pos.remainingTokens > 0 ? quoteSolOut / pos.remainingTokens : 0;
    } catch {}

    // Get liquidity from GMGN
    let liqUsd = 0;
    let liqSol = 0;
    let holders = 0;
    let devStatus = '';
    try {
      const info = await gmgn.gmgnTokenInfo(pos.tokenMint);
      liqUsd = parseFloat(info?.liquidity || '0');
      liqSol = parseFloat(info?.pool?.quote_reserve || '0');
      holders = info?.holder_count || 0;
      devStatus = info?.dev?.creator_token_status || '';
    } catch {}

    const currentValueSol = quoteSolOut;
    const totalValueSol = currentValueSol + (pos.totalSolReceived || 0);
    const pnlSol = totalValueSol - pos.solSpent;
    const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;
    const isProfit = pnlSol >= 0;
    const emoji = isProfit ? '🟢' : '🔴';

    // Rug risk indicator
    let rugRisk = '';
    if (liqUsd < 1000) rugRisk = '🔴 RUG RISK';
    else if (liqUsd < 5000) rugRisk = '🟡 Low Liq';
    else rugRisk = '🟢 OK';

    // Partial sell status
    const partials = (pos.partialSells || []);
    const soldPartials = partials.filter(s => s.sold).length;
    const totalPartials = partials.filter(s => s.enabled !== false).length;

    lines.push(
      `<b>${pos.symbol}</b>`,
      `<code>${pos.tokenMint}</code>`,
      `💰 Entry: ${pos.solSpent} SOL → Now: ${currentValueSol.toFixed(4)} SOL`,
      `${emoji} PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`,
      ``,
      `💧 Liq: $${liqUsd.toFixed(0)} (${liqSol.toFixed(1)} SOL) ${rugRisk}`,
      `👥 Holders: ${holders} | Dev: ${devStatus}`,
      `📉 Peak: +${pos.peakPnlPct || 0}% | Trailing: ${pos.trailingDropPct || 15}%`,
      `🎯 Partial: ${soldPartials}/${totalPartials} sold | SL: -${pos.slPct}%`,
      `📦 Remaining: ${pos.remainingTokens.toFixed(2)} tokens`,
      `💰 Sold: ${(pos.totalSolReceived || 0).toFixed(4)} SOL`,
      ``,
    );
  }

  // Send with inline keyboard buttons for each position
  for (const pos of open) {
    const posLines = [];
    // Find lines for this position in the main text
    const mintShort = pos.tokenMint.slice(0, 8);
    
    // Get current quote for this position
    const { getQuote, SOL_MINT } = require('../src/trading');
    let quoteSolOut = 0;
    try {
      const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      quoteSolOut = parseFloat(quote.outAmount) / 1e9;
    } catch {}
    
    const totalValueSol = quoteSolOut + (pos.totalSolReceived || 0);
    const pnlSol = totalValueSol - pos.solSpent;
    const pnlPct = pos.solSpent > 0 ? (pnlSol / pos.solSpent * 100) : 0;
    const emoji = pnlSol >= 0 ? '🟢' : '🔴';
    
    const msg = [
      `<b>${pos.symbol}</b>`,
      `<code>${pos.tokenMint}</code>`,
      `💰 Entry: ${pos.solSpent} SOL → Now: ${quoteSolOut.toFixed(4)} SOL`,
      `${emoji} PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`,
      `📦 Remaining: ${pos.remainingTokens.toFixed(2)} tokens`,
    ].join('\n');
    
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: positionButtons(pos.tokenMint),
    });
  }
}

// ─── /pnl — show PNL summary ──────────────────────────
async function handlePnl(chatId) {
  const open = positions.getOpenPositions();
  const closed = positions.getClosedPositions(100); // get all closed for totals

  let openPnl = 0;

  // Calculate open PNL using Jupiter quote (same as checkPositions)
  for (const pos of open) {
    try {
      const { getQuote, SOL_MINT } = require('../src/trading');
      const rawAmount = Math.floor(pos.remainingTokens * Math.pow(10, pos.decimals));
      const quote = await getQuote(pos.tokenMint, SOL_MINT, rawAmount, 500);
      const quoteSolOut = parseFloat(quote.outAmount) / 1e9;
      const totalValue = quoteSolOut + (pos.totalSolReceived || 0);
      openPnl += totalValue - pos.solSpent;
    } catch {
      // fallback: skip if no quote
    }
  }

  // Today's PNL (reset at 7 AM WIB = 0:00 UTC)
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayClosed = closed.filter(c => c.closedAt && new Date(c.closedAt) >= utcMidnight);
  const todayPnl = todayClosed.reduce((sum, c) => sum + (c.pnl || 0), 0);
  const todayWins = todayClosed.filter(c => (c.pnl || 0) > 0).length;
  const todayLosses = todayClosed.length - todayWins;
  const todayWinRate = todayClosed.length > 0 ? (todayWins / todayClosed.length * 100).toFixed(0) : '?';

  // Total PNL (all-time)
  const totalClosedPnl = closed.reduce((sum, c) => sum + (c.pnl || 0), 0);
  const totalWins = closed.filter(c => (c.pnl || 0) > 0).length;
  const totalLosses = closed.length - totalWins;
  const totalWinRate = closed.length > 0 ? (totalWins / closed.length * 100).toFixed(0) : '?';

  // Recent trades (last 10)
  const recent = closed.slice(0, 10);

  const lines = [
    `📊 <b>PNL Summary</b>`,
    ``,
    `🕐 All-Time: ${closed.length} trades`,
    `💰 Total PNL: ${totalClosedPnl >= 0 ? '+' : ''}${totalClosedPnl.toFixed(4)} SOL`,
    `🎯 Win Rate: ${totalWinRate}% (${totalWins}W/${totalLosses}L)`,
    ``,
    `📅 Today (7AM WIB): ${todayClosed.length} trades`,
    `💰 Today PNL: ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)} SOL`,
    `🎯 Win Rate: ${todayWinRate}% (${todayWins}W/${todayLosses}L)`,
    ``,
    `📈 Open Positions: ${open.length}`,
    `💰 Open PNL: ${openPnl >= 0 ? '+' : ''}${openPnl.toFixed(4)} SOL`,
    ``,
    `📋 Recent (last 10):`,
  ];

  for (const c of recent) {
    const emoji = c.pnl >= 0 ? '🟢' : '🔴';
    const reason = c.closeReason || 'manual';
    const pnlStr = c.pnl >= 0 ? `+${c.pnl.toFixed(4)}` : `${c.pnl.toFixed(4)}`;
    const pctStr = c.pnlPct != null ? (c.pnlPct >= 0 ? `+${c.pnlPct.toFixed(1)}` : `${c.pnlPct.toFixed(1)}`) : '';
    lines.push(`${emoji} ${c.symbol}: ${pnlStr} SOL ${pctStr ? `(${pctStr}%)` : ''} ${reason}`);
  }

  await tgApi('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', reply_markup: mainMenu() });
}

// ─── /remove — remove from screening list
async function handleRemove(chatId, args) {
  if (!args[0]) {
    await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /remove <token_mint>', parse_mode: 'HTML' });
    return;
  }

  const removed = positions.removeFromScreening(args[0]);
  if (removed) {
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Removed from screening list.`, parse_mode: 'HTML' });
  } else {
    await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ Token not found in screening list.`, parse_mode: 'HTML' });
  }
}

// ─── /config — auto-trade config ───────────────────────
async function handleConfig(chatId, args) {
  if (!args.length) {
    const cfg = autotrade.getAutoConfig();
    const ps = cfg.partialSells || [];
    const psLines = ps.map((s, i) => {
      if (s.enabled === false) return `  ${i+1}. ❌ OFF`;
      return `  ${i+1}. Sell ${s.sellPct}% at +${s.atPct}% PNL`;
    });
    const remaining = 100 - ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);

    const lines = [
      `⚙️ <b>Auto-Trade Config</b>`,
      ``,
      `🤖 Enabled: ${cfg.enabled ? '✅ ON' : '❌ OFF'}`,
      `💰 Buy Amount: ${cfg.buyAmountSol} SOL`,
      `🛑 SL: -${cfg.slPct}%`,
      `📉 Trailing Drop: ${cfg.trailingDropPct}% from peak`,
      `🎯 Trailing Trigger: peak PNL > +${cfg.trailingTriggerPct || 20}%`,
      `📊 Min Score: ${cfg.minScore}`,
      `📦 Max Positions: ${cfg.maxOpenPositions}`,
      `⏱ Check Interval: ${cfg.checkIntervalSec}s`,
      `🔍 Scan Interval: ${cfg.scanIntervalMin || 10} min`,
      `📈 Slippage: ${cfg.slippageBps / 100}%`,
      ``,
      `🎯 <b>Partial Sell Levels:</b>`,
      ...psLines,
      `  → ${remaining > 0 ? remaining : 0}% remaining → trailing TP/SL`,
      ``,
      `<b>Commands:</b>`,
      `/config on|off — Toggle auto-trade`,
      `/config amount 0.1 — Buy amount (SOL)`,
      `/config sl 50 — Stop loss %`,
      `/config trail 15 — Trailing drop %`,
      `/config trailtrigger 20 — Trailing activate after peak PNL %`,
      `/config score 60 — Min screener score`,
      `/config maxpos 3 — Max open positions`,
      `/config interval 5 — Position check (sec)`,
      `/config scan 5 — Screener scan (min)`,
      `/config partial — Show partial levels`,
      `/config part1 50 25 — Lv1: sell 25% at +50%`,
      `/config part2 100 25 — Lv2: sell 25% at +100%`,
      `/config part3 200 25 — Lv3: sell 25% at +200%`,
      `/config part2 off — Disable Lv2`,
      `/config partial [add|remove|reset]`,
    ];
    const r = await tgApi('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: configButtons(cfg) });
    if (!r.ok) console.error('[BOT] /config sendMessage failed:', r.description);
    else console.log('[BOT] /config sent OK');
    return;
  }

  const sub = args[0].toLowerCase();
  const val = parseFloat(args[1]);
  const val2 = parseFloat(args[2]);

  if (sub === 'on') {
    autotrade.updateAutoConfig({ enabled: true });
    await tgApi('sendMessage', { chat_id: chatId, text: '✅ Auto-trade enabled', parse_mode: 'HTML' });
  } else if (sub === 'off') {
    autotrade.updateAutoConfig({ enabled: false });
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Auto-trade disabled', parse_mode: 'HTML' });
  } else if (sub === 'amount' && val > 0) {
    autotrade.updateAutoConfig({ buyAmountSol: val });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Buy amount: ${val} SOL`, parse_mode: 'HTML' });
  } else if (sub === 'sl' && val > 0) {
    autotrade.updateAutoConfig({ slPct: val });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ SL: -${val}%`, parse_mode: 'HTML' });
  } else if ((sub === 'trail' || sub === 'trailing') && val > 0) {
    autotrade.updateAutoConfig({ trailingDropPct: val });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Trailing drop: ${val}% from peak`, parse_mode: 'HTML' });
  } else if (sub === 'trailtrigger' && val > 0) {
    autotrade.updateAutoConfig({ trailingTriggerPct: val });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Trailing trigger: activate after peak PNL > +${val}%`, parse_mode: 'HTML' });
  } else if (sub === 'score' && val > 0) {
    autotrade.updateAutoConfig({ minScore: val });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Min score: ${val}`, parse_mode: 'HTML' });
  } else if (sub === 'maxpos' && val > 0) {
    autotrade.updateAutoConfig({ maxOpenPositions: Math.floor(val) });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Max positions: ${Math.floor(val)}`, parse_mode: 'HTML' });
  } else if (sub === 'interval' && val > 0) {
    const sec = Math.max(3, Math.floor(val)); // min 3s to prevent overlap
    autotrade.updateAutoConfig({ checkIntervalSec: sec });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Position check interval: ${sec}s`, parse_mode: 'HTML' });
  } else if (sub === 'scan' && val > 0) {
    const min = Math.max(1, Math.floor(val)); // min 1 min
    autotrade.updateAutoConfig({ scanIntervalMin: min });
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Scan interval: ${min} min`, parse_mode: 'HTML' });
  } else if (sub === 'partial') {
    await handlePartialConfig(chatId, args.slice(1));
  } else if (/^part[1-3]$/.test(sub) && args[1] && args[1].toLowerCase() === 'off') {
    const idx = parseInt(sub.replace('part', '')) - 1;
    const ps = autotrade.disablePartialSell(idx);
    if (!ps) {
      await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ Level ${idx+1} not found`, parse_mode: 'HTML' });
      return;
    }
    const level = ps[idx];
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Lv${idx+1} disabled (${level.atPct}% target preserved)`, parse_mode: 'HTML' });
  } else if (/^part[1-3]$/.test(sub) && args[1] && args[1].toLowerCase() === 'on') {
    const idx = parseInt(sub.replace('part', '')) - 1;
    const ps = autotrade.enablePartialSell(idx);
    if (!ps) {
      await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ Level ${idx+1} not found`, parse_mode: 'HTML' });
      return;
    }
    const level = ps[idx];
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Lv${idx+1} enabled: sell ${level.sellPct}% at +${level.atPct}%`, parse_mode: 'HTML' });
  } else if (/^part[1-3]$/.test(sub) && val > 0 && val2 > 0) {
    const idx = parseInt(sub.replace('part', '')) - 1;
    const ps = autotrade.editPartialSell(idx, val, val2);
    if (!ps) {
      await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ Level ${idx+1} not found`, parse_mode: 'HTML' });
      return;
    }
    const totalSell = ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Lv${idx+1}: sell ${val2}% at +${val}% (${totalSell}% allocated)`, parse_mode: 'HTML' });
  } else {
    await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Unknown config option. Use /config to see all commands.', parse_mode: 'HTML' });
  }
}

// ─── /config partial — manage partial sell levels ──────
async function handlePartialConfig(chatId, args) {
  if (!args.length) {
    const cfg = autotrade.getAutoConfig();
    const ps = cfg.partialSells || [];
    const psLines = ps.map((s, i) => {
      if (s.enabled === false) return `  ${i+1}. ❌ OFF`;
      return `  ${i+1}. Sell ${s.sellPct}% at +${s.atPct}% PNL`;
    });
    const remaining = 100 - ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);
    const lines = [
      `🎯 <b>Partial Sell Levels</b>`,
      ``,
      ...psLines,
      `  → ${remaining > 0 ? remaining : 0}% remaining → trailing TP/SL`,
      ``,
      `<b>Commands:</b>`,
      `/config partial add 75 20 — sell 20% at +75%`,
      `/config partial edit 2 75 20 — edit level 2`,
      `/config partial remove 75 — remove level at +75%`,
      `/config partial reset — reset to defaults`,
    ];
    await tgApi('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
    return;
  }

  const action = args[0].toLowerCase();

  if (action === 'reset') {
    const ps = autotrade.resetPartialSells();
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Partial sells reset to defaults (${ps.length} levels)`, parse_mode: 'HTML' });
  } else if (action === 'add' && args.length >= 3) {
    const atPct = parseFloat(args[1]);
    const sellPct = parseFloat(args[2]);
    if (isNaN(atPct) || isNaN(sellPct) || atPct <= 0 || sellPct <= 0 || sellPct > 100) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /config partial add &lt;atPct&gt; &lt;sellPct&gt;\\nExample: /config partial add 75 20', parse_mode: 'HTML' });
      return;
    }
    const ps = autotrade.addPartialSell(atPct, sellPct);
    const totalSell = ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Added: sell ${sellPct}% at +${atPct}%\\nTotal: ${ps.length} levels (${totalSell}% allocated)`, parse_mode: 'HTML' });
  } else if (action === 'edit' && args.length >= 4) {
    const levelIdx = parseInt(args[1]);
    const atPct = parseFloat(args[2]);
    const sellPct = parseFloat(args[3]);
    if (isNaN(levelIdx) || isNaN(atPct) || isNaN(sellPct) || levelIdx < 1 || atPct <= 0 || sellPct <= 0 || sellPct > 100) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /config partial edit &lt;level&gt; &lt;atPct&gt; &lt;sellPct&gt;\\nLevel starts at 1. Example: /config partial edit 2 75 20', parse_mode: 'HTML' });
      return;
    }
    const ps = autotrade.editPartialSell(levelIdx - 1, atPct, sellPct);
    if (!ps) {
      await tgApi('sendMessage', { chat_id: chatId, text: `⚠️ Level ${levelIdx} not found. Use /config partial to see levels.`, parse_mode: 'HTML' });
      return;
    }
    const totalSell = ps.reduce((sum, s) => sum + (s.enabled !== false ? s.sellPct : 0), 0);
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Level ${levelIdx} updated: sell ${sellPct}% at +${atPct}%\\nTotal: ${ps.length} levels (${totalSell}% allocated)`, parse_mode: 'HTML' });
  } else if (action === 'remove' && args.length >= 2) {
    const atPct = parseFloat(args[1]);
    if (isNaN(atPct)) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /config partial remove &lt;atPct&gt;', parse_mode: 'HTML' });
      return;
    }
    const ps = autotrade.removePartialSell(atPct);
    await tgApi('sendMessage', { chat_id: chatId, text: `✅ Removed level at +${atPct}%\nRemaining: ${ps.length} levels`, parse_mode: 'HTML' });
  } else {
    await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /config partial [add|remove|reset]', parse_mode: 'HTML' });
  }
}

// ─── Route Command ─────────────────────────────────────
async function routeCommand(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.+/, '');
  const args = parts.slice(1);

  switch (cmd) {
    case '/wallet': return handleWallet(chatId, args);
    case '/buy': return handleBuy(chatId, args);
    case '/sell': return handleSell(chatId, args);
    case '/sellall': return handleSellAll(chatId, args);
    case '/positions': case '/pos': return handlePositions(chatId);
    case '/pnl': return handlePnl(chatId);
    case '/remove': case '/delete': case '/del': return handleRemove(chatId, args);
    case '/config': return handleConfig(chatId, args);
    default: return false;
  }
  return true;
}

module.exports = { routeCommand };
