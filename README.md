# GMGN Screener + Auto Trader

Solana token screener with automated trading, rug detection, bundler detection, and wallet management via Telegram bot.

---

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/kontia1/gmgn-screener.git
cd gmgn-screener

# 2. Install dependencies
npm install

# 3. Install gmgn-cli globally
npm install -g gmgn-cli

# 4. Configure gmgn-cli with your API key
gmgn-cli config set api_key YOUR_GMGN_API_KEY

# 5. Create .env from example
cp .env.example .env
# Edit .env with your credentials (see Environment Variables below)

# 6. Import wallet via Telegram bot
#    Send /wallet import <your_base58_private_key> to your bot

# 7. Run
node index.js
```

---

## Running in Background

### Option A: Screen (simple, no root)

```bash
# Start in detached screen session
screen -dmS gmgn node index.js

# View live output
screen -r gmgn

# Detach (leave running): Ctrl+A then D

# Check if running
screen -ls

# Stop
screen -S gmgn -X quit
```

### Option B: Systemd (auto-restart, auto-start on boot)

```bash
# Install systemd service
sudo cp gmgn-screener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gmgn-screener
sudo systemctl start gmgn-screener

# Management
sudo systemctl status gmgn-screener     # Check status
sudo journalctl -u gmgn-screener -f     # View logs
sudo systemctl restart gmgn-screener    # Restart
sudo systemctl stop gmgn-screener       # Stop
```

**Auto-restart:** Service auto-restarts on crash (RestartSec=10) and starts on boot.

---

## Features Overview

### 1. Triple-Source Token Screener

Automatically scans Solana tokens from **three independent sources** at configurable intervals.

**Sources:**
| Source | Description | Adaptive Filters |
|--------|-------------|------------------|
| **Trending** | GMGN trending tokens | Full filters (MC, momentum, volume) |
| **Trenches** | GMGN trenches/new pairs | Skips MC filter, skips momentum, volume min = 0 |
| **Signal** | GMGN market signals (18 types) | Per-signal weights, anti-double-count |

Each source has its own **seen list** (`gmgn-seen-trending.json`, `gmgn-seen-trenches.json`, `gmgn-seen-signal.json`) — same token can be detected by multiple sources independently.

**How it works:**
1. Fetches tokens from selected source (GMGN API)
2. Applies multi-layer filtering (Default or Custom mode)
3. For trenches: enriches price data via `gmgn-cli token info` (real price + 5m/1h change)
4. For signal: applies per-signal weight adjustment to base score
5. Scores tokens 0-100 based on 9 weighted criteria
6. Auto-buys tokens passing the score threshold
7. Dedup tracking prevents re-alerting the same token per source

**Scoring System (0-100):**

Scored positively:
| Criteria | Weight | Description |
|----------|--------|-------------|
| Holders | 12 | Holder count (500+, 1000+) |
| Smart Degens | 15 | Smart money wallets holding (5+, 10+) |
| Volume | 12 | 24h volume (200K+, 500K+) |
| Wash Trading | 3 | No wash trading detected |
| Top 10 Holders | 5 | Top 10 holder rate (< 50%) |
| Socials | 7 | Website + Twitter + Telegram presence |
| CTO | 3 | Community Take Over status |
| Liquidity | 4 | Pool liquidity (30K+, 50K+) |
| Snipers | 3 | Sniper count (10-40 sweet spot) |

Scored negatively (penalties):
| Criteria | Penalty | Description |
|----------|---------|-------------|
| Wash trading | -25 | Wash trading detected |
| No socials | -8 | No website, Twitter, or Telegram |
| Top 10 > 50% | -10 | Extreme holder concentration |
| Bundler | -15 | Bundled launch detected |
| Entrapment > 15% | -10 | High entrapment ratio |
| Snipers > 40 | -8 | Too many snipers |
| Momentum overshoot | -10 | 1h > 500% (too late to enter) |
| B/S < 0.8x | -5 | More sells than buys |
| 1h drop > 20% | -4 | Significant price decline |

Capped at 0-100.

**Filter Modes:**

*Default Mode (hardcoded, never changes):*
```
maxAge: 60 min
minMC: $10K
maxMC: $500K
minVol: $5K
minBuyRatio: 1.2x
maxBundler: 25%
maxTop10HolderRate: 95%
```

*Custom Mode (editable via Telegram):*
```
minAge      — Minimum token age (0 = no filter)
maxAge      — Maximum token age (minutes)
minMC       — Minimum market cap ($0 = no filter)
maxMC       — Maximum market cap ($0 = no filter)
minVol      — Minimum 24h volume ($0 = no filter)
minLiq      — Minimum liquidity ($0 = no filter)
maxLiq      — Maximum liquidity ($0 = no filter)
minBuyRatio — Minimum buy/sell ratio
maxBundler  — Max bundler % (supply concentration)
maxTop10    — Max top 10 holder % (supply concentration)
minHolder   — Minimum holder count (0 = no filter)
```

All filter values can be set to **0** (disabled/no filter).

**Debug Logging:**
When enabled, shows detailed filter breakdown per scan:
```
[SCREEN] TOKEN (CA): score 75
  ✅ age: 45m (need 30-60m)
  ✅ mc: $120K (need $50K-$200K)
  ✅ vol: $35K (need $20K+)
  ✅ buyRatio: 1.8x (need 1.5x+)
  ✅ bundler: 12% (need <20%)
  ✅ top10: 78% (need <85%)
  ✅ holders: 89 (need 50+)
  → PASSED (score 75)
```

---

### 2. Auto Trading

**Auto Buy:**
- Automatically buys tokens passing score threshold
- Configurable buy amount (SOL)
- Configurable slippage (bps)
- Jupiter V6 API for best-route swap
- **Global buy lock:** 300s cooldown per CA (source-agnostic, configurable)
- **Re-check enabled** before autoBuy (race condition fix)

**Auto Sell (Multi-Strategy Exit):**

*Partial Sell Levels (configurable):*
```
Lv1: Sell 40% at +15% PNL
Lv2: Sell 25% at +30% PNL
Lv3: Sell 25% at +50% PNL
Remaining: exits via Trailing TP or Hard SL
```

*Trailing Take Profit:*
- Activates when peak PNL exceeds trigger threshold (default: +13%)
- Sells when price drops from peak by configurable % (default: 10%)
- Example: Token pumps to +40%, trailing activates, drops to +30% → sells

*2-Layer Stop Loss:*
```
Soft SL: -20% → wait 15s for recovery
  ├─ Price recovers above -20% → reset, continue holding
  └─ Price stays below -20% after 15s → sell

Hard SL: -35% → instant sell (no waiting)
```

**Position Monitor:**
- Checks all open positions every 10s (configurable 10-3600s)
- 2s delay between position checks (anti rate-limit)
- Uses Jupiter quotes for accurate PNL calculation
- Tracks peak price and peak PNL for trailing
- **Live prices + live liquidity** in positions menu

**Dead Token Auto-Close:**
- Tracks `quoteFailCount` per position
- Increments on each `NO_ROUTES_FOUND` (only when both Jupiter AND GMGN price fail)
- GMGN price fallback: when Jupiter has no routes, uses GMGN price for PNL calculation
- Resets to 0 on successful quote (Jupiter or GMGN)
- Auto-closes position after **3 consecutive failures** (both sources failed)

**Dry-Run Mode:**
- Virtual trading with **exact same logic as live mode**
- Buy: Jupiter quote → token amount → virtual position
- PNL: same formula as live (quoteSolOut - solSpent)
- Sell: Jupiter quote → virtual SOL received
- Separate storage (`dry-run-positions.json`, `dry-run-closed.json`)
- Toggle via Telegram menu (`/config` → Mode)
- All button handlers support dry-run (buy, sell, refresh, positions)
- Notifications prefixed with 🟡 DRY RUN or 🔴 LIVE

**Wallet Empty Auto-Close:**
- Monitors wallet balance during position check
- If balance = 0 → auto-close all positions + notification

---

### 3. Position Rug Detector

**Per-position monitoring** — checks each open position every **30 seconds** for rug signals.

**6 Rug Signals (scored 0-100):**
| Signal | Score | Detection |
|--------|-------|-----------|
| Price crash | 30 | > -50% from entry |
| Liquidity drain | 25 | > -60% liquidity drop |
| Top holder dump | 20 | Top holder sold > 50% |
| Volume spike + dump | 15 | 10x volume + price drop |
| Honeypot sell fail | 5 | Sell transaction reverts |
| LP removal | 5 | Liquidity removed from pool |

**Auto-Sell Threshold:** Score ≥ 30 → automatic sell + rug notification

**Pre-Bond Skip:** Skips liquidity drain signal for tokens with < $10K liquidity (pre-bond phase has naturally volatile liquidity).

---

### 4. Bundler Detector

Detects **bundled token launches** where one entity controls multiple wallets to buy in the same block.

**3 Detection Rules:**
| Rule | Threshold | Description |
|------|-----------|-------------|
| Rule 1 | ≥20 transfers from ≤5 payers | Classic bundle pattern |
| Rule 2 | ≥15 burst transfers in single block | Same-block bundle |
| Rule 3 | ≥80% supply from ≤3 wallets | Extreme concentration |

**Classification:**
- **ACTIVE bundler** — detected in last 15 seconds (block-level activity)
- **HISTORICAL bundler** — detected previously but not currently active

**Filter:** Rejects tokens with bundled launches. Uses Helius Enhanced Transactions API.

**Cache:** 15-second cache per wallet to avoid redundant API calls.

---

### 5. SmartMoney + KOL Tracker (4th + 5th Discovery Source)

Discovers tokens via SmartMoney wallet activity and KOL (Key Opinion Leader) buys.

**SmartMoney Tracker:**
- Monitors GMGN SmartMoney API for buy activity
- Configurable: interval, min amount, side (buy/sell), min score
- Shows wallet count + confidence level in alerts
- Confidence: 1=Low, 2-3=Med, 4+=High

**KOL Tracker:**
- Monitors GMGN KOL API for buy activity
- Same configurable parameters as SmartMoney
- Confidence: 1=Low, 2=Med, 3+=High

**Key behavior:**
- SM/KOL are **discovery sources**, NOT score boosters
- Base score comes from `scoreToken()` (murni, no boost)
- Per-source minScore: Trending 40, Signal 45, SM 50, KOL 55
- All settings editable via `/tracker` command

---

### 6. Signal Scanner (3rd Discovery Source)

GMGN market signals as a third token discovery layer, running alongside trending and trenches.

**18 Signal Types:**
| Type | Name | Direction | Description |
|------|------|-----------|-------------|
| 1 | Smart Money Buy | Positive | Smart money wallet buying |
| 2 | KOL Buy | Positive | Key opinion leader buying |
| 3 | Volume Surge | Positive | Unusual volume spike |
| 4 | Holder Growth | Positive | Rapid holder increase |
| 5 | Buy Pressure | Positive | Buy/sell ratio spike |
| 6 | Price Breakout | Positive | Price breaking resistance |
| 7 | Liquidity Add | Positive | LP adding liquidity |
| 8 | Whale Buy | Positive | Large wallet buying |
| 9 | Fresh Wallet | Positive | New wallet buying |
| 10 | Sniper Activity | Neutral | Sniper bot detected |
| 11 | Smart Money Sell | Negative | Smart money selling |
| 12 | KOL Sell | Negative | KOL selling |
| 13 | Liquidity Remove | Penalty | LP removing liquidity |
| 17 | Bot Degenerate | Negative | Bot activity detected |

**Config:**
- MC range: $10K-$100K (configurable)
- Signal interval: 30s (configurable)
- Per-signal weights: individually toggleable (0-100)
- Anti-double-count: keeps highest score per token
- Dedup: 6h window, skip if already in seen list
- Hard reject signals: type 11, 12, 13 (auto-reject if active)

**Score Adjustment:**
- Base score from screener + signal contribution
- Signal contribution = (active_signals / total_weight) * signalRatio
- Capped at maxContribution (default: +30 points)
- Applied AFTER base scoring, BEFORE threshold check

---

### 7. Wallet Management

**Multi-Wallet Support:**
- Import existing wallet (base58 private key)
- Create new wallet
- List all wallets
- Remove wallet
- Switch between wallets

**Token Account Management:**

*Close Rugs:*
- Scans wallet for orphaned tokens (no open position)
- Scans open positions for dead/rugged tokens
- Scans for zero-balance token accounts
- Sells valuable tokens via Jupiter
- Closes dead token accounts (recovers ~0.002 SOL rent each)
- Batch close (10 accounts per transaction)

*Close Empty Accounts:*
- Lists all zero-balance token accounts
- Shows estimated rent recovery
- One-click batch close
- Supports both SPL Token and Token-2022 programs

---

### 8. PNL Tracking

**PNL Summary (via 📈 PNL button):**
```
📊 PNL Summary

📊 All-Time
📈 Trades: 45
💰 Total PNL: -0.2340 SOL
🏆 Win Rate: 12W/33L (27%)

📊 Today (resets 7am WIB)
📈 Trades: 8
💰 Today PNL: +0.0450 SOL
🏆 Win Rate: 5W/3L (63%)

📊 Open Positions: 3
💰 Open PNL: +0.0125 SOL (+27.8%)

📋 Recent:
🟢 TOKEN: +0.0075 SOL (+50.0%) auto-sell
🔴 RUG: -0.0150 SOL (-100%) dead_token
🟢 BRETT: +0.0030 SOL (+20.0%) trailing
```

**PNL Layout Order:** All-Time → Today → Open Positions → Recent

**PNL Format:**
- Win rate: `12W/33L` format
- PNL sign: always explicit `+` or `-` prefix
- Daily reset at **7:00 AM WIB** (00:00 UTC)
- All-time PNL never resets
- Open PNL calculated via Jupiter quotes
- **Mode-dependent:** live mode shows live only, dry-run mode shows dry-run only

---

### 9. Telegram Bot Interface

**Main Menu (via /start or /menu):**
```
🤖 GMGN Screener

📊 Positions: 3/5
🤖 Auto-Trade: ✅ ON
💰 Buy: 0.015 SOL | 🛑 SL: -25%
📉 Trail: 10% | 📊 Score: 45
🔍 Source: Signal (Custom)
🔒 Buy Lock: 120s

Select option:

[📊 Positions] [📈 PNL]
[⚙️ Config] [💼 Wallet]
[📋 Screener] [🔄 Refresh]
```

**Commands:**
```
/start       — Show main menu
/menu        — Show main menu
/buy <CA>    — Buy token manually
/sell <CA> [pct] — Sell token (default 100%)
/sellall     — Sell all open positions
/positions   — Show open positions
/pnl         — Show PNL summary
/wallet      — Wallet management
/config      — Show/edit config
/tracker     — SmartMoney + KOL tracker settings
/screen      — Run screener manually (one-shot)
/help        — Show all commands
```

**Inline Keyboard Navigation:**
- All menus use inline buttons
- No need to type commands
- Tap to navigate between menus
- Real-time data refresh
- Hyperlink format for all external links (GMGN, Birdeye, Solscan)

**Notification Buttons:**
- Auto-buy, auto-sell, and partial sell notifications include inline keyboard buttons
- Quick access to token info, sell, and position management

---

### 10. Config Management

**Configurable Parameters:**

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Auto-Trade | OFF | ON/OFF | Enable/disable auto trading |
| Mode | dry_run | live/dry_run | Trading mode |
| Buy Amount | 1 SOL | 0.001-10 | SOL per buy |
| Soft SL | -20% | -5 to -50 | Soft stop loss (wait for recovery) |
| Soft SL Wait | 15s | 5-120 | Seconds to wait before soft SL sells |
| Hard SL | -35% | -5 to -95 | Hard stop loss (instant sell) |
| Trail Drop | 10% | 1-50 | Drop from peak to trigger trailing |
| Trigger | +13% | +5 to +100 | Peak PNL to activate trailing |
| Score | 45 | 10-100 | Min screener score to auto-buy |
| Max Positions | 5/10 | 1-20 | Max concurrent positions (live/dry) |
| Check Interval | 10s | 10-3600 | Position check frequency (seconds) |
| Scan Interval | 30s | 10-3600 | Screener scan frequency (seconds) |
| Slippage | 500 bps | 10-5000 | Swap slippage tolerance |
| Buy Lock | 120s | 0-600 | Cooldown per CA (source-agnostic) |

**Partial Sells:**
- 3 configurable levels
- Each level: atPct (trigger PNL) + sellPct (% to sell)
- Can enable/disable each level individually
- Remaining % exits via trailing TP or SL

---

### 11. Jupiter Integration

**Jupiter V6 API:**
- Best-route swap across all Solana DEXes
- API key support for premium routing
- No maxAccounts limitation (Jupiter handles optimal routing)
- Automatic retry on 429 rate limits (3x with backoff: 2s, 4s)

**Swap Flow:**
```
1. Get quote from Jupiter (inputMint → outputMint)
2. Get swap transaction (serialized)
3. Sign with wallet keypair
4. Send to Solana RPC
5. Confirm transaction
6. Record in positions store
```

**Supported Operations:**
- Buy: SOL → Token
- Sell: Token → SOL
- Partial sell: Token → SOL (configurable %)
- Close: Token → SOL (100% + close account)

---

### 12. Token-2022 Support

**Full Support for Both Programs:**
- SPL Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
- Token-2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)

**Operations Supported:**
- Balance checking (both programs)
- Token transfers
- Account closing
- Rent recovery

---

### 13. Rate Limit Safety

**Position Check Rate:**
```
Formula: maxPos × delay ≤ checkInterval

5 positions × 2s = 10s (0.5 req/s) ✅
10 positions × 2s = 20s (0.5 req/s) ✅
20 positions × 2s = 40s (0.5 req/s) ✅
```

**429 Handling:**
- Automatic retry 3x with exponential backoff
- 2s → 4s → 8s delays
- Applied to getQuote and getSwapTx
- Logs rate limit events

**API Limits:**
- Jupiter: ~2 req/s (safe), 429 after burst
- GMGN: ~1 req/s (safe), 429 after burst
- Helius RPC: 100 req/s (paid plan)

---

### 14. Analytics Logging

Tracks buy/reject decisions per source for performance analysis.

**Logged data:**
- Token symbol, address, source
- Base score, min score threshold
- Decision (buy/reject) + reason
- Price, MC, age at time of decision
- SmartMoney/KOL confidence + wallet count

**Storage:** `data/analytics/decisions-YYYY-MM-DD.json` (7-day auto-cleanup)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_RPC_URL` | Yes | Solana RPC endpoint (Helius recommended) |
| `HELIUS_API_KEY` | Yes | Helius API key (for bundler detection) |
| `JUPITER_API_URL` | No | Jupiter API URL (default: `https://api.jup.ag/swap/v1`) |
| `JUPITER_API_KEY` | No | Jupiter API key for premium routing |
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `BOT_USERNAME` | No | Telegram bot username (for inline links) |
| `CHAT_ID` | Yes | Your Telegram chat ID |
| `GMGN_API_KEY` | Yes | GMGN API key (`x-apikey` header) |
| `WALLET_PRIVATE_KEY` | No | Base58 private key (alternative to `/wallet import`) |
| `ALLOWED_CHAT_IDS` | No | Comma-separated chat IDs (empty = allow all) |

---

## File Structure

```
gmgn-screener/
├── index.js              Entry point
├── bot.js                Telegram polling + command router
├── screener.js           GMGN scanner (trending + trenches + signal)
├── src/
│   ├── autotrade.js      Auto buy/sell + 2-layer SL + rug detection
│   ├── trading.js        Jupiter swap execution
│   ├── positions.js      Position store + PNL tracking
│   ├── wallet.js         Wallet management + account cleanup
│   ├── buttons.js        Telegram inline keyboard handlers
│   ├── config.js         Config management
│   ├── bundler-detector.js  Bundler detection (Helius API)
│   ├── signal-scanner.js GMGN market signal scanner (3rd source)
│   ├── smartmoney-tracker.js  SmartMoney + KOL tracker (4th+5th source)
│   ├── dry-run.js        Dry-run storage (mirrors positions.js)
│   ├── rug-detector.js   GMGN data comparison for rug signals
│   ├── scorer.js         Multi-factor scoring (0-100)
│   ├── filter.js         Token filtering logic
│   ├── analytics.js      Decision logging (buy/reject per source)
│   └── utils.js          Helpers (fmtMc, fmtVol, etc.)
├── commands/
│   └── trade.js          Telegram commands
├── lib/
│   └── shared.js         GMGN CLI + Telegram API
├── scripts/
│   └── telegram_config.json  Bot token config
├── config/
│   └── wallet.json       Wallet keypair (auto-created, gitignored)
├── data/
│   ├── auto-config.json  Trading config (custom filters)
│   ├── positions.json    Open positions
│   ├── closed.json       Closed positions
│   ├── dry-run-positions.json  Dry-run open positions
│   ├── dry-run-closed.json     Dry-run closed positions
│   ├── signal-config.json      Signal scanner config
│   └── analytics/        Decision logs (7-day auto-cleanup)
├── output/
│   ├── gmgn-seen-trending.json   Seen tokens (trending source)
│   ├── gmgn-seen-trenches.json   Seen tokens (trenches source)
│   ├── gmgn-seen-signal.json     Seen tokens (signal source)
│   └── bundler-data.json         Bundler detection cache
├── .env                  Environment variables (gitignored)
├── .env.example          Environment template
└── .gitignore
```

---

## License

Private — Not for distribution.
