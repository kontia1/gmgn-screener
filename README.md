# GMGN Screener + Auto Trader

Solana token screener with automated trading, rug detection, and wallet management via Telegram bot.

---

## Features Overview

### 1. Token Screener

**GMGN Phase 2 Scanner** — automatically scans trending Solana tokens at configurable intervals (default: every 3 minutes).

**How it works:**
- Fetches trending tokens from GMGN API
- Applies multi-layer filtering (Default or Custom mode)
- Scores tokens 0-100 based on 9 weighted criteria
- Auto-buys tokens passing the score threshold
- Dedup tracking prevents re-alerting the same token

**Scoring System (0-100):**
| Criteria | Weight | Description |
|----------|--------|-------------|
| PrePump | 25% | Early pump signals (volume spike, price consolidation) |
| Consolidation | 20% | Price stability pattern |
| Safety | 10% | Honeypot detection, contract safety |
| Activity | 10% | Trading activity, buy/sell ratio |
| Project | 10% | Website, Twitter, Telegram presence |
| Momentum | 10% | Price momentum indicators |
| Age | 5% | Token age (newer = higher score) |
| Liquidity | 5% | Pool liquidity depth |
| VolumeAccel | 5% | Volume acceleration signal |

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
minAge      — Minimum token age (minutes)
maxAge      — Maximum token age (minutes)
minMC       — Minimum market cap ($)
maxMC       — Maximum market cap ($)
minVol      — Minimum 24h volume ($)
minBuyRatio — Minimum buy/sell ratio
maxBundler  — Max bundler % (supply concentration)
maxTop10    — Max top 10 holder % (supply concentration)
minHolder   — Minimum holder count
```

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
- Jupiter V1 API for best-route swap

**Auto Sell (Multi-Strategy Exit):**

*Partial Sell Levels (configurable):*
```
Lv1: Sell 50% at +15% PNL
Lv2: Sell 25% at +30% PNL
Lv3: Sell 25% at +50% PNL
Remaining: exits via Trailing TP or Hard SL
```

*Trailing Take Profit:*
- Activates when peak PNL exceeds trigger threshold (default: +15%)
- Sells when price drops from peak by configurable % (default: 5%)
- Example: Token pumps to +40%, trailing activates, drops to +35% → sells

*Hard Stop Loss:*
- Sells entire position when PNL drops below threshold (default: -25%)
- Always active, overrides partial sells

**Position Monitor:**
- Checks all open positions every 10s (configurable 5-60s)
- 2s delay between position checks (anti rate-limit)
- Uses Jupiter quotes for accurate PNL calculation
- Tracks peak price and peak PNL for trailing

**Position Display (via Telegram):**
```
🟢 TOKEN
CA: 0x1234...5678
💰 Spent: 0.0150 SOL
📊 Now: 0.0225 SOL
📈 PNL: +0.0075 SOL (+50.0%)
🔝 Peak: +65.2%
💧 Liq: $45K
📊 MC: $180K
[Bridge: Pump.fun]
```

---

### 3. Rug Detection

**Three types of rug notifications:**

**🚨 RUG WARNING — Massive Dump Detection**
- Triggers when PNL drops below -90%
- Early warning before SL triggers
- Shows entry price, current value, PNL

**💀 RUG DETECTED — Token Dead**
- Triggers when Jupiter returns NO_ROUTES_FOUND 3 consecutive times
- Auto-closes position
- Shows loss amount and reason

**💀 RUG Auto-Sell — SL Trigger with Severe Loss**
- Triggers when SL fires but PNL is below -80%
- Shows as "RUG" instead of normal "Auto-Sell"
- Includes peak PNL and TX link

**Dead Token Auto-Close:**
- Tracks `quoteFailCount` per position
- Increments on each NO_ROUTES_FOUND
- Resets to 0 on successful quote
- Auto-closes position after 3 consecutive failures

---

### 4. Wallet Management

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

**Wallet Menu:**
```
💼 Wallet

📍 abc123...xyz789
💰 SOL: 0.5432

🪙 Tokens (3):
  • USDC: 1.50
  • BRETT: 1000.00
  • TOKEN: 500.00

🗑️ Empty accounts: 15
  (recoverable rent: ~0.030 SOL)

[🗑️ Close 15 Empty Accounts]
[💀 Close Rugs] [🔄 Refresh]
[🔙 Back]
```

---

### 5. PNL Tracking

**PNL Summary (via /pnl command):**
```
📊 PNL Summary

📊 Open Positions: 3
💰 Open PNL: +0.0125 SOL (+27.8%)

📊 All-Time
📈 Trades: 45
💰 Total PNL: -0.2340 SOL
🏆 Win Rate: 12W/33L (27%)

📊 Today (resets 7am WIB)
📈 Trades: 8
💰 Today PNL: +0.0450 SOL
🏆 Win Rate: 5W/3L (63%)

📋 Recent:
🟢 TOKEN: +0.0075 SOL (+50.0%) auto-sell
🔴 RUG: -0.0150 SOL (-100%) dead_token
🟢 BRETT: +0.0030 SOL (+20.0%) trailing
```

**PNL Reset:**
- Daily reset at 7:00 AM WIB (00:00 UTC)
- All-time PNL never resets
- Open PNL calculated via Jupiter quotes

---

### 6. Telegram Bot Interface

**Main Menu (via /start or /menu):**
```
🤖 GMGN Screener + Trader

📊 Positions: 3/5
🤖 Auto-Trade: ✅ ON
💰 Buy: 0.015 SOL | 🛑 SL: -25%
📉 Trail: 5% | 📊 Score: 40

Select option:

[📊 Positions] [📈 PNL]
[⚙️ Config] [💼 Wallet]
[📋 Screener] [🔄 Refresh]
```

**Commands:**
```
/start    — Show main menu
/menu     — Show main menu
/buy <CA> — Buy token manually
/sell <CA> [pct] — Sell token (default 100%)
/sellall  — Sell all open positions
/positions — Show open positions
/pnl      — Show PNL summary
/wallet   — Wallet management
/config   — Show/edit config
/help     — Show all commands
```

**Inline Keyboard Navigation:**
- All menus use inline buttons
- No need to type commands
- Tap to navigate between menus
- Real-time data refresh

---

### 7. Config Management

**Config Menu (via ⚙️ Config button):**
```
⚙️ Config

🤖 Auto-Trade: ✅ ON
💰 Buy: 0.015 SOL
🛑 SL: -25%
📉 Trail: 5%
🎯 Trigger: +15%
📊 Score: 40
📦 Max: 5
⏱ Check: 10s
🔍 Scan: 3m
📈 Slippage: 5%

🎯 Partial Sells:
  1. Sell 50% at +15%
  2. Sell 25% at +30%
  3. Sell 25% at +50%
  → 0% trailing TP/SL

🔍 Screener: Custom
  Age: 30-60m
  MC: $50K-$200K
  Vol: $20K+
  B/S: 1.5x+
  Bundler: <20%
  Top10: <85%
  Min Holders: 50

Tap button to edit value:

[🤖 Auto: ON] [💰 Buy: 0.015]
[🛑 SL: -25%] [📉 Trail: 5%]
[🎯 Trigger: +15%] [📊 Score: 40]
[📦 Max: 5] [⏱ Check: 10s]
[🔍 Scan: 3m] [📈 Slip: 5%]
[🎯 Partial Sells]
[🔍 Filter: Custom]
[🔙 Back]
```

**Configurable Parameters:**

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Auto-Trade | OFF | ON/OFF | Enable/disable auto trading |
| Buy Amount | 0.05 SOL | 0.001-10 | SOL per buy |
| Stop Loss | -50% | -5 to -95 | Hard SL threshold |
| Trail Drop | 15% | 1-50 | Drop from peak to trigger trailing |
| Trigger | +20% | +5 to +100 | Peak PNL to activate trailing |
| Score | 60 | 10-100 | Min screener score to auto-buy |
| Max Positions | 5 | 1-20 | Max concurrent positions |
| Check Interval | 15s | 5-60 | Position check frequency |
| Scan Interval | 10m | 1-60 | Screener scan frequency |
| Slippage | 500 bps | 10-5000 | Swap slippage tolerance |

**Partial Sells:**
- 3 configurable levels
- Each level: atPct (trigger PNL) + sellPct (% to sell)
- Can enable/disable each level individually
- Remaining % exits via trailing TP or SL

---

### 8. Jupiter Integration

**Jupiter V1 API:**
- Best-route swap across all Solana DEXes
- API key support for premium routing
- No maxAccounts limitation (Jupiter handles optimal routing)
- Automatic retry on 429 rate limits (3x with backoff)

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

### 9. Token-2022 Support

**Full Support for Both Programs:**
- SPL Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
- Token-2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)

**Operations Supported:**
- Balance checking (both programs)
- Token transfers
- Account closing
- Rent recovery

**Why It Matters:**
- Many new tokens use Token-2022
- Older bots only support SPL Token
- Missing Token-2022 = missing opportunities

---

### 10. Rate Limit Safety

**Position Check Rate:**
```
Formula: maxPos × delay ≤ checkInterval

5 positions × 2s = 10s (0.5 req/s) ✅
10 positions × 2s = 20s (0.5 req/s) ✅
15 positions × 2s = 30s (0.5 req/s) ✅
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
- Solana RPC: varies by provider (Helius: 100 req/s)

---

### 11. Systemd Service

**Installation:**
```bash
sudo cp gngmscreener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gngmscreener
sudo systemctl start gngmscreener
```

**Management:**
```bash
# Check status
sudo systemctl status gngmscreener

# View logs
sudo journalctl -u gngmscreener -f

# Restart
sudo systemctl restart gngmscreener

# Stop
sudo systemctl stop gngmscreener
```

**Auto-restart:**
- Service auto-restarts on crash
- Logs to journalctl
- Starts on boot (if enabled)

---

## Quick Start

```bash
# 1. Clone / copy project
cd gngmscreener

# 2. Install dependencies
npm install

# 3. Install gmgn-cli (if not installed)
npm install -g gmgn-cli

# 4. Configure gmgn-cli with your API key
gmgn-cli config set api_key YOUR_GMGN_API_KEY

# 5. Create .env from example
cp .env.example .env
# Edit .env with your values

# 6. Import wallet via Telegram bot
#    Send /wallet import <your_base58_private_key> to your bot

# 7. Run
node index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_RPC_URL` | Yes | Solana RPC endpoint (Helius recommended) |
| `JUPITER_API_URL` | No | Jupiter API URL (default: `https://api.jup.ag/swap/v1`) |
| `JUPITER_API_KEY` | No | Jupiter API key for premium routing |
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `CHAT_ID` | Yes | Your Telegram chat ID |
| `GMGN_API_KEY` | Yes | GMGN API key (`x-apikey` header) |
| `WALLET_PRIVATE_KEY` | No | Base58 private key (alternative to `/wallet import`) |
| `ALLOWED_CHAT_IDS` | No | Comma-separated chat IDs (empty = allow all) |

## File Structure

```
├── index.js              Entry point
├── bot.js                Telegram polling + command router
├── screener.js           GMGN Phase 2 scanner
├── src/
│   ├── autotrade.js      Auto buy/sell + rug detection
│   ├── trading.js        Jupiter swap execution
│   ├── positions.js      Position store + PNL tracking
│   ├── wallet.js         Wallet management + account cleanup
│   ├── buttons.js        Telegram inline keyboard handlers
│   ├── config.js         Config management
│   └── utils.js          Helpers
├── commands/
│   └── trade.js          Telegram commands
├── lib/
│   └── shared.js         GMGN CLI + Telegram API
├── config/
│   └── wallet.json       Wallet keypair (auto-created)
├── data/
│   ├── auto-config.json  Trading config (custom filters)
│   ├── positions.json    Open positions
│   └── closed.json       Closed positions
├── output/
│   └── gmgn-seen.json    Screener dedup tracker
└── .env                  Credentials (never commit)
```

## License

Private — do not distribute.
