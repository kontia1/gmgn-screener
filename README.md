# GMGN Screener + Auto Trader

Solana token screener with automated trading, rug detection, bundler detection, and wallet management via Telegram bot.

---

## Features

### 1. Token Screener (3 Sources)

**Trending** — GMGN trending tokens, real-time scan every 10-60s
**Trenches** — GMGN new pairs, very early detection
**Signal** — GMGN market signals (18 types), 3rd discovery layer

Each source has independent:
- Scan interval
- Seen list (dedup)
- Adaptive filters (trenches skips MC/momentum/volume filters)

### 2. Auto-Trade Engine

**Auto-Buy:**
- Screener detects token → score ≥ threshold → auto-buy
- Jupiter V6 swap (buy: SOL → token)
- Bundler check before buy (blocks if bundler detected)
- Dedup: per-source + global (configurable TTL)

**Auto-Sell (4 triggers):**
- **Hard SL**: instant sell at -35% (configurable)
- **Soft SL**: wait 15s at -20%, sell if no recovery
- **Trailing TP**: trigger at +13% peak, sell on -10% drop
- **Partial Sells**: 40% at +15%, 25% at +30%, 25% at +50%

**Exit Strategies:**
- Dead token: NO_ROUTES_FOUND x3 → auto-close
- Bundler detected: Helius API confirms → sell immediately
- Rug signal: GMGN data change (holders drop, entrapment spike) → sell
- Rug warning: PNL ≤ -90% → alert + SL will trigger

### 3. Dry-Run Mode

Virtual trading with **exact same logic as live mode**:
- Buy: Jupiter quote → token amount → virtual position
- PNL: same formula as live (quoteSolOut - solSpent)
- Sell: Jupiter quote → virtual SOL received
- Separate storage (dry-run-positions.json, dry-run-closed.json)
- Toggle via Telegram menu or config

### 4. Position Management

**Monitoring Loop** (every 10s):
- Jupiter quote for current price
- PNL calculation (SOL-denominated)
- Peak tracking
- Soft SL timer (start → wait → sell or recover)
- Bundler check every 30s
- Rug signal check every 30s (GMGN data comparison)

**PNL Tracking:**
- All-time: total trades, PNL, win rate
- Today (7 AM WIB reset): daily PNL, win rate
- Open positions: live PNL via Jupiter quote
- Recent trades: last 10 with emoji + reason

### 5. Bundler Detection

- Helius Enhanced Transactions API
- Detects: funded by same wallet, batch transfers, coordinated buys
- Distinguishes: ACTIVE (still bundling) vs HISTORICAL (past only)
- Cache: 15s per token
- Auto-sell if active bundler detected

### 6. Rug Detection

Compares current GMGN data with entry snapshot:
- Holder exodus: >40% drop → rug signal
- Entrapment spike: >15% → rug signal
- Top 10 concentration: >80% → rug signal
- Fresh wallet rate: >50% → rug signal
- Volume collapse: >90% drop → rug signal
- Score: ≥60 = rug, triggers auto-sell

### 7. Signal Scanner (3rd Source)

GMGN market signals as discovery layer:
- 18 signal types (smart money, KOL, volume, etc.)
- Per-signal configurable weights
- Anti-double-count (keeps highest score per token)
- Dedup: 6h window, skip if already seen
- MC range: $10K-$100K (configurable)
- Signal ratio: 0.3 (minimum contribution threshold)

### 8. Scoring System

Multi-factor scoring (0-100):
- Safety: wash trading, bundler, entrapment
- Activity: volume, buy/sell ratio, holders
- Liquidity: pool depth, MC/Liq ratio
- Project: socials, website, renounced
- PrePump: price change, volume acceleration
- Momentum: 5m/1h change, hot level
- Consolidation: tight range, higher lows
- VolAccel: volume spike + flat price

### 9. Telegram Bot

**Commands:**
- `/start` — main menu
- `/buy <CA> <SOL>` — manual buy
- `/sell <CA> [pct]` — sell (100% default)
- `/sellall <CA>` — sell all
- `/positions` — open positions with live PNL
- `/pnl` — PNL summary (all-time + today + recent)
- `/config` — settings menu

**Inline Menus:**
- Main menu: positions, PNL, config, screener, wallet
- Config: mode, amounts, SL, trailing, filters, source
- Positions: per-token with sell/refresh buttons
- Screener: source selector, filter editor
- Signal: per-signal weight editor

### 10. Wallet Management

- Multi-wallet support (configurable label)
- Token balance check
- SOL balance check
- Auto-close position if wallet empty

### 11. Filters

**Default Filters (hardcoded):**
- Age: 15-120 min
- MC: $5K-$100K
- Volume: ≥$2K
- Liquidity: ≥$4K
- Holders: ≥10
- Buy ratio: ≥1.5x
- Smart degen: ≥1
- Entrapment: ≤8%
- Sniper: 0-50
- Price change 5m: -10% to +100%
- Price change 1h: ≤200%

**Custom Filters** (editable via Telegram):
- All above + visiting count, hot level, wash trading, bundler rate, top 10 holders

### 12. Dedup System

- Per-source seen list (trending, trenches, signal)
- Global dedup cache (configurable TTL, default 180s)
- Prevents same token from multiple sources

---

## Architecture

```
src/
├── autotrade.js      # Auto-trade engine (buy, sell, SL, TP)
├── bundler-detector.js # Helius API bundler detection
├── buttons.js        # Telegram inline keyboard handlers
├── dry-run.js        # Dry-run storage (mirrors positions.js)
├── filter.js         # Token filtering logic
├── positions.js      # Live position storage
├── rug-detector.js   # GMGN data comparison
├── scorer.js         # Multi-factor scoring
├── signal-scanner.js # GMGN market signal scanner
├── trading.js        # Jupiter V6 swap (buy/sell/quote)
├── wallet.js         # Solana wallet management
commands/
├── trade.js          # /buy, /sell, /sellall, /positions, /pnl
lib/
├── shared.js         # GMGN CLI wrapper, Telegram helper
```

---

## Configuration

All config in `data/auto-config.json`:

```json
{
  "mode": "dry_run",           // "live" or "dry_run"
  "enabled": true,             // auto-trade on/off
  "buyAmountSol": 0.01,        // buy amount per trade
  "slippageBps": 500,          // slippage (5%)
  "softSlPct": 20,             // soft SL threshold
  "softSlWaitSec": 15,         // soft SL wait time
  "hardSlPct": 35,             // hard SL threshold
  "trailingDropPct": 10,       // trailing TP drop %
  "trailingTriggerPct": 13,    // trailing TP trigger %
  "minScore": 40,              // minimum score to buy
  "maxOpenPositions": 10,      // max concurrent positions
  "checkIntervalSec": 10,      // position check interval
  "scanIntervalSec": 30,       // screener scan interval
  "screenerSource": "trending", // "trending", "trenches", "signal"
  "filterMode": "default",     // "default" or "custom"
  "customFilters": { ... },    // custom filter overrides
  "partialSells": [ ... ],     // partial sell levels
  "dedup": { "globalTtlSec": 180 }
}
```

---

## Environment Variables

```env
# Required
GMGN_API_KEY=your_gmgn_api_key
JUPITER_API_KEY=your_jupiter_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Optional
HELIUS_API_KEY=your_helius_key  # for bundler detection
ALCHEMY_API_KEY=your_alchemy_key
```

---

## Running

```bash
# Install dependencies
npm install

# Start
node index.js

# Or via systemd
sudo systemctl start gmgn-screener
sudo systemctl status gmgn-screener
sudo journalctl -u gmgn-screener -f
```

---

## Safety

- Private keys in `~/.agent/credentials/wallet.env` (never in repo)
- API keys in `.env` (gitignored)
- Dry-run mode: zero risk, virtual trades only
- Bundler detection: blocks buys from known bundler patterns
- Rug detection: monitors GMGN data changes
- 2-layer SL: soft (wait) + hard (instant)
