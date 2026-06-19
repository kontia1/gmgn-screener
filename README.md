# GMGN Screener + Auto Trader

Solana token screener with automated trading, rug protection, smart money tracking, and wallet management — all controlled via Telegram bot.

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

### Option A: Screen

```bash
screen -dmS gmgn node index.js   # Start detached
screen -r gmgn                    # View live output
# Detach: Ctrl+A then D
screen -ls                        # Check if running
screen -S gmgn -X quit           # Stop
```

### Option B: Systemd (auto-restart, auto-start on boot)

```bash
sudo cp gmgn-screener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gmgn-screener
sudo systemctl start gmgn-screener
```

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

## Features

### 1. Dual Token Screener (Trending + Trenches)

Automatically scans Solana tokens from two independent sources at configurable intervals.

**Sources:**
- **Trending** — GMGN trending tokens with full filters (market cap, momentum, volume)
- **Trenches** — GMGN trenches/new pairs with relaxed filters (skips MC filter, momentum check disabled, volume min = 0)

Each source maintains its own **seen list** — the same token can be detected by both sources independently.

**How it works:**
1. Fetches tokens from GMGN API
2. Applies multi-layer filtering (Default or Custom mode)
3. Enriches price data via `gmgn-cli token info` (real price + 5m/1h change)
4. Scores tokens 0-100 based on 9 weighted criteria
5. Auto-buys tokens passing the score threshold
6. Dedup tracking prevents re-alerting per source

**Scoring System (0-100):**

Positive criteria:
- **Holders** (12 pts) — Holder count (500+, 1000+)
- **Smart Degens** (15 pts) — Smart money wallets holding (5+, 10+)
- **Volume** (12 pts) — 24h volume (200K+, 500K+)
- **Wash Trading** (3 pts) — No wash trading detected
- **Top 10 Holders** (5 pts) — Top 10 holder rate (< 50%)
- **Socials** (7 pts) — Website + Twitter + Telegram presence
- **CTO** (3 pts) — Community Take Over status
- **Liquidity** (4 pts) — Pool liquidity (30K+, 50K+)
- **Snipers** (3 pts) — Sniper count (10-40 sweet spot)

Negative criteria (penalties):
- **Wash trading** (-25) — Wash trading detected
- **No socials** (-8) — No website, Twitter, or Telegram
- **Top 10 > 50%** (-10) — Extreme holder concentration
- **Bundler** (-15) — Bundled launch detected
- **Entrapment > 15%** (-10) — High entrapment ratio
- **Snipers > 40** (-8) — Too many snipers
- **Momentum overshoot** (-10) — 1h > 500% (too late to enter)
- **B/S < 0.8x** (-5) — More sells than buys
- **1h drop > 20%** (-4) — Significant price decline

Capped at 0-100.

**Filter Modes:**

*Default Mode (hardcoded):*
```
maxAge: 60 min
minMC: $10K
maxMC: $500K
minVol: $5K
minBuyRatio: 1.2x
maxBundler: 25%
maxTop10HolderRate: 95%
```

*Custom Mode (editable via Telegram `/config`):*
All filters adjustable — minAge, maxAge, minMC, maxMC, minVol, minLiq, minBuyRatio, maxBundler, maxTop10, minHolder, maxBotDegenRate, maxEntrapment, minHotLevel, minVisitingCount, maxPriceChange1h, minPriceChange5m, maxPriceChange5m. All values can be set to **0** to disable.

**Duplicate Filters (separate section in `/config`):**
Toggle ON/OFF independently. When ON, threshold `0` = ORI only (reject all duplicates).

| Filter | Description | Default |
|--------|-------------|---------|
| maxImageDup | Max logo image duplicate count | 0 (ORI only) |
| maxTwitterDup | Max Twitter handle duplicate count | 0 (ORI only) |
| maxTelegramDup | Max Telegram link duplicate count | 0 (ORI only) |
| maxWebsiteDup | Max website URL duplicate count | 0 (ORI only) |
| maxTwitterCreateTokenCount | Max tokens created by same Twitter | 0 (ORI only) |

Toggle OFF = skip duplicate check entirely. Toggle ON + threshold 0 = reject any token with duplicates (strictest). Toggle ON + threshold 5 = allow tokens with up to 5 duplicates (relaxed).

---

### 2. Signal Scanner

GMGN market signals as a third token discovery layer, running alongside trending and trenches.

**18 Signal Types:**
- **Positive:** Smart Money Buy, KOL Buy, Volume Surge, Holder Growth, Buy Pressure, Price Breakout, Liquidity Add, Whale Buy, Fresh Wallet
- **Neutral:** Sniper Activity
- **Negative:** Smart Money Sell, KOL Sell, Liquidity Remove, Bot Degenerate

**Config:**
- MC range: $10K-$100K (configurable)
- Signal interval: 30s (configurable)
- Per-signal weights: individually toggleable (0-100)
- Anti-double-count: keeps highest score per token
- Dedup: 6h window
- Hard reject signals: Smart Money Sell, KOL Sell, Liquidity Remove (auto-reject if active)

**Score Adjustment:**
- Base score from screener + signal contribution
- Capped at maxContribution (default: +30 points)
- Applied AFTER base scoring, BEFORE threshold check

---

### 3. SmartMoney Tracker

Monitors GMGN SmartMoney API for buy activity as an additional discovery source.

- Configurable interval, min amount, side (buy/sell), min score
- Shows wallet count + confidence level in alerts
- Confidence levels: 1=Low, 2-3=Med, 4+=High
- Per-source minScore: 50
- Editable via `/tracker` command

---

### 4. KOL Tracker

Monitors GMGN KOL (Key Opinion Leader) API for buy activity.

- Same configurable parameters as SmartMoney
- Confidence levels: 1=Low, 2=Med, 3+=High
- Per-source minScore: 55
- Editable via `/tracker` command

---

### 5. Auto-Trade with 4-Layer Protection

Automated trading engine with multi-layer safety mechanisms.

**Auto Buy:**
- Jupiter V6 API for best-route swap across all Solana DEXes
- Configurable buy amount (SOL) and slippage (bps)
- Global buy lock: configurable cooldown per CA (source-agnostic)
- Re-check before autoBuy (race condition fix)

**Pre-Buy Validation (prevents wasted fees on dead tokens):**
- **Price impact check** — rejects if price impact > 10% (pool likely drained)
- **OutAmount sanity check** — rejects if output tokens ≤ 0 (dead pool)
- **Liquidity recheck** — fetches current GMGN pool data before swap; rejects if liquidity dropped > 50% from scan time
- **Preflight simulation** — Solana simulates TX before on-chain submission (saves ~0.000055 SOL on doomed swaps)
- **Auto-retry** — on simulation or on-chain failure, retries once with fresh Jupiter quote
- **Buy lock cleanup** — releases 30s pending lock immediately on failure

**4-Layer Protection (scan-before-buy):**

| Layer | Check | Timeout | Description |
|-------|-------|---------|-------------|
| 1 | Bundler check | 3s | Rejects bundled launches |
| 2 | Soft SL pre-check | 3s | Verifies token hasn't already crashed |
| 3 | Liquidity drain check | 10s | Detects active liquidity removal |
| 4 | Main scan | 10s | Full score + filter validation |

Each layer runs sequentially — if any layer rejects, the buy is skipped.

---

### 6. 2-Layer Stop Loss

Dual stop-loss system combining quick recovery protection with hard exit.

**Soft SL:**
- Triggers at configurable threshold (default: -20%)
- Waits configurable duration for recovery (default: 30s)
- If price recovers above threshold → reset, continue holding
- If price stays below threshold → sell
- Hard SL enforcement runs at 1s frequency during soft SL wait period

**Hard SL:**
- Triggers at configurable threshold (default: -25%)
- Instant sell — no waiting for recovery
- Acts as ultimate safety net
- **Dynamic threshold:** High-risk entries (entryRiskScore ≥ 60) get tighter hard SL (15%)
- Entry risk score based on: entrapment, bundler rate, liquidity at buy time

---

### 7. Trailing Take Profit

Dynamic profit-taking that locks in gains as price rises.

- Activates when peak PNL exceeds trigger threshold (default: +13%)
- Tracks peak price continuously
- Sells when price drops from peak by configurable % (default: 10%)
- Example: Token pumps to +40%, trailing activates, drops to +30% → sells

---

### 8. Partial Sells

Configurable multi-level exit strategy.

**Default Levels:**
- **Level 1:** Sell 40% at +15% PNL
- **Level 2:** Sell 25% at +30% PNL
- **Level 3:** Sell 25% at +50% PNL
- **Remaining:** Exits via Trailing TP or Hard SL

Each level individually toggleable with configurable trigger PNL and sell percentage.

---

### 9. Rug Detection

Real-time per-position monitoring with graduated response system. Runs independently at 1-second frequency via dedicated fast-check loop.

**9 Rug Signals (scored 0-100):**
- **Holder exodus** (30) — Holder count drops > 30% from entry
- **Top10 consolidation** (30) — Top 10 holder rate spikes > 50% from entry
- **Liquidity removal** (100) — LP fully removed ($0 from > $1K)
- **Liquidity drain** (30) — Liquidity drops > 50% from entry
- **Entrapment spike** (20) — Entrapment ratio rises above 15% (was < 5%)
- **Creator concentration** (25) — Creator holds > 90% of supply
- **Fresh wallets** (15) — > 95% fresh wallets (possible bot/fake wallets)
- **Price drop (Jupiter)** (50) — Real-time price dropped > 40% from entry
- **Price impact spike** (40) — Price impact grew > 3x in 60 seconds

**Graduated Response (score-based):**

| Score | Level | Action |
|-------|-------|--------|
| 10-29 | Watch | Log + console only |
| 30-49 | Warn | Telegram alert, watching |
| 50-74 | Partial | Sell 50% immediately |
| 75+ | Exit | Full exit |

**Fast-Check Loops (independent from main 10s cycle):**

| Loop | Interval | Purpose |
|------|----------|---------|
| Bundler fast | 3s | Active bundler burst detection |
| Soft SL fast | 3s | Hard SL enforcement during soft SL wait |
| Liq drain | 10s | Liquidity collapse detection (≥50% drop = instant exit) |
| Rug fast | 1s | Full rug signal check + Jupiter price drop + NO_ROUTES pre-check |

**NO_ROUTES Pre-Check:** Before calling GMGN API, rug loop checks Jupiter for swap routes. If NO_ROUTES detected → token is dead → instant full exit. Catches unsellable tokens before expensive API calls.

**API Error Handling:** Retries 3x on GMGN API failure. If all retries fail and position is > 30 minutes old, treats as suspicious (isRug = true). Absolute checks (creator hold >90%, top10 >90%, entrapment >90%) don't require snapshot comparison — they detect rugs even without historical data.

**Pre-Bond Skip:** Skips liquidity drain signal for tokens with < $10K liquidity (pre-bond phase has naturally volatile liquidity).

---

### 10. Liquidity Drain Detection

Real-time monitoring of pool liquidity changes as part of the rug detection system.

- Monitors liquidity depth on each position check
- Triggers on > -60% liquidity drop from entry
- Integrated into the 4-layer buy protection (Layer 3)
- Part of the rug score calculation (25 points)
- Pre-bond tokens excluded from drain signal

---

### 11. Bundler Detection

Detects bundled token launches where one entity controls multiple wallets to buy in the same block.

**3 Detection Rules:**
- **Rule 1:** ≥20 transfers from ≤5 payers (classic bundle pattern)
- **Rule 2:** ≥15 burst transfers in single block (same-block bundle)
- **Rule 3:** ≥80% supply from ≤3 wallets (extreme concentration)

**Classification:**
- **ACTIVE** — detected in last 15 seconds (block-level activity)
- **HISTORICAL** — detected previously but not currently active

Uses Helius Enhanced Transactions API with 15-second cache per wallet. Bundled launches are rejected during screening and during the 4-layer buy protection.

---

### 12. Blocklist System

Token and wallet blocking to prevent repeated exposure to known bad actors.

- Block tokens manually or automatically (rugged, bundled)
- Block wallets associated with scam activity
- Blocklist persists across sessions
- Blocked tokens skipped during all screener scans
- Manage via Telegram bot commands

---

### 13. Sell Lock Mutex

Concurrency control preventing conflicting sell operations on the same position.

- One sell operation per position at a time
- Prevents double-sell from simultaneous triggers (e.g., soft SL + rug detector)
- Automatic lock release after sell completes or fails
- Protects against race conditions in multi-strategy exit

---

### 14. Dry Run Mode

Virtual trading with exact same logic as live mode — no real transactions.

- **Buy:** Jupiter quote → token amount → virtual position
- **PNL:** Same formula as live (quoteSolOut - solSpent)
- **Sell:** Jupiter quote → virtual SOL received
- Separate storage (`dry-run-positions.json`, `dry-run-closed.json`)
- Toggle via Telegram menu (`/config` → Mode)
- All button handlers support dry-run (buy, sell, refresh, positions)
- Notifications prefixed with 🟡 DRY RUN or 🔴 LIVE
- Mode-dependent PNL: live mode shows live only, dry-run shows dry-run only

---

### 15. Telegram Bot with Inline Keyboard

Full bot control via Telegram with inline keyboard navigation.

**Main Menu:**
```
🤖 GMGN Screener

📊 Positions: 3/5
🤖 Auto-Trade: ✅ ON
💰 Buy: 0.015 SOL | 🛑 SL: -25%
📉 Trail: 10% | 📊 Score: 45
🔍 Source: Signal (Custom)
🔒 Buy Lock: 120s

[📊 Positions] [📈 PNL]
[⚙️ Config] [💼 Wallet]
[📋 Screener] [🔄 Refresh]
```

**Commands:**
- `/start` / `/menu` — Show main menu
- `/buy <CA>` — Buy token manually
- `/sell <CA> [pct]` — Sell token (default 100%)
- `/sellall` — Sell all open positions
- `/positions` — Show open positions
- `/pnl` — Show PNL summary
- `/wallet` — Wallet management
- `/config` — Show/edit config
- `/tracker` — SmartMoney + KOL tracker settings
- `/help` — Show all commands

**Notifications:** Auto-buy, auto-sell, partial sell, and rug alerts include inline keyboard buttons for quick access to token info, sell, and position management.

**PNL Summary:**
- All-Time and Today stats (daily reset at 7:00 AM WIB / 00:00 UTC)
- Win rate in `12W/33L` format
- Open position PNL with live Jupiter quotes
- Recent trade history with exit reasons

---

### 16. Configurable via /config

All trading parameters editable in real-time via Telegram.

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Auto-Trade | OFF | ON/OFF | Enable/disable auto trading |
| Mode | dry_run | live/dry_run | Trading mode |
| Buy Amount | 1 SOL | 0.001-10 | SOL per buy |
| Soft SL | -20% | -5 to -50 | Soft stop loss (wait for recovery) |
| Soft SL Wait | 30s | 5-120 | Seconds to wait before soft SL sells |
| Hard SL | -25% | -5 to -95 | Hard stop loss (instant sell) |
| Trail Drop | 15% | 1-50 | Drop from peak to trigger trailing |
| Trigger | +30% | +5 to +100 | Peak PNL to activate trailing |
| Score | 50 | 10-100 | Min screener score to auto-buy |
| Max Positions | 5 | 1-20 | Max concurrent positions |
| Check Interval | 10s | 10-3600 | Position check frequency (seconds) |
| Scan Interval | 30s | 10-3600 | Screener scan frequency (seconds) |
| Slippage | 500 bps | 10-5000 | Swap slippage tolerance |
| Buy Lock | 300s | 0-600 | Cooldown per CA (source-agnostic) |
| Liq Drain Exit | 50% | 10-90 | Liquidity drop % to trigger exit |
| Liq Drain Warn | 30% | 10-80 | Liquidity drop % to trigger warning |
| Liq Drain Check | 10s | 5-60 | Liquidity check interval |

---

## License

Private — Not for distribution.
