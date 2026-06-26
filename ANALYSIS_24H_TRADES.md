# Trade Analysis: Rugs vs Wins (Last 24h)

## Summary Stats
- **26 trades** in last 24h
- **10 rugs** (38.5%) — HARD SL or Liq Drain
- **13 wins** (50%) — positive PnL
- **3 other** (manual/breakeven)
- **Net PnL: -0.082 SOL** (negative due to rug losses)
- Average rug loss: ~0.019 SOL each (~95% loss)
- Average win gain: ~0.007 SOL each

## Critical Finding: Rug Speed
- Average rug alive time: **27 seconds**
- Fastest rug: **3.8 seconds**
- The rug detector (3s loop) cannot react fast enough. **Pre-entry filtering is the only defense.**

---

## Differentiating Patterns at Entry Time

### 1. BuyRatio (buys/sells) — STRONGEST SIGNAL
| Metric | Rugs (median) | Wins (median) |
|--------|--------------|---------------|
| buyRatio | 2.80 | 2.16 |

**Problem**: The `scoreToken()` function gives **+12 points for buyRatio >= 3.0**. This rewards bot-inflated buy pressure in brand new tokens.

**Data**: 4/10 rugs had buyRatio > 3.0 vs 2/13 wins. The 3 AIAIAI rugs (same tweet) had ratios of 3.68, 4.00, 4.21.

### 2. Bundler Rate — HIGH SIGNAL
| Metric | Rugs (median) | Wins (median) |
|--------|--------------|---------------|
| bundlerRate | 0.051 | 0.031 |

**Problem**: The `scoreToken()` function only gives **-3 for bundler >= 0.25**. The penalty gap between 0.05 and 0.25 is too lenient. Most rugs cluster at 0.04-0.08 bundler rate, which gets +2 to +4 in the current system.

### 3. Sniper Wallets — STRONG SIGNAL (from early data subset)
| Metric | Rugs (median) | Wins (median) |
|--------|--------------|---------------|
| sniperWallets | 5 | 0 |

ONI rug had **29 sniper wallets** — should be an instant skip.

### 4. Bundler Wallets — MODERATE SIGNAL
| Metric | Rugs (median) | Wins (median) |
|--------|--------------|---------------|
| bundlerWallets | 7.5 | 4.5 |

ONI rug had **43 bundler wallets**.

### 5. Duplicate Tweet References — STRONG SIGNAL
- **3 of 10 rugs** came from the same Elon tweet (`elonmusk/status/2070042592012570970`)
- Bot bought 3 different CAs referencing the same tweet; 2 were instant rugs, 1 won
- Same-tweet copycat tokens are a known rug pattern

### 6. Website Quality — MODERATE SIGNAL
- 5/10 rugs had websites vs **10/13 wins** had websites
- Rug websites were often tweet links or fake domains

### 7. Twitter Account Type — WEAK SIGNAL
- 8/10 rugs had twitter as `/status/` URL (specific tweet) vs 7/13 wins
- Not a strong standalone filter

### 8. Entry Risk Score — NOT USEFUL
- 9/10 rugs had riskScore=60, 12/13 wins had riskScore=60
- The risk score formula doesn't differentiate: `entrapment + bundlerRate + liquidity`

---

## Root Cause Analysis

### Problem 1: Score Function Rewards Rug Signals
The `scoreToken()` in screener.js:
- **+12 for buyRatio >= 3.0** ← REWARDS bot-inflated pressure
- **+4 for bundlerRate < 0.05** ← Only catches cleanest tokens
- **-3 for bundlerRate >= 0.25** ← Penalty too mild, most rugs are 0.04-0.10
- **No penalty for sniperWallets** ← Missing signal entirely
- **No penalty for bundlerWallets count** ← Missing signal
- **No duplicate tweet detection** ← Missing signal

### Problem 2: Entry Risk Score is Too Simple
Current formula (autotrade.js line 330-334):
```js
entryRiskScore = (entrapment < 0.05 ? 40 : 0) +
                 (bundlerRate > 0.15 ? 30 : bundlerRate > 0.10 ? 20 : 0) +
                 (liq < 30000 ? 20 : liq < 60000 ? 10 : 0)
```
Only uses 3 signals. Doesn't use buyRatio, sniper wallets, bundler wallets, or duplicate references.

### Problem 3: No Duplicate Reference Detection
Same tweet being used by multiple CAs is a major rug signal. No tracking exists.

---

## Concrete Improvements

### HIGH PRIORITY (implement immediately)

#### 1. Fix BuyRatio Scoring for New Tokens
In `screener.js` `scoreToken()`:
```
// For tokens < 2min old, high buyRatio = bot activity, not organic demand
if (ageMin < 2 && ratio >= 3.0) { score -= 5; } // penalize
else if (ratio >= 3.0) { score += 12; } // keep reward for older tokens
```
**Impact**: Blocks 4/10 rugs, costs 2/13 wins

#### 2. Add Bundler Rate Progressive Penalty
In `screener.js` `scoreToken()`:
```
if (bundler >= 0.10) { score -= 8; }     // was -3 at >= 0.25
else if (bundler >= 0.06) { score -= 3; } // new: penalize medium bundler
else if (bundler < 0.05) { score += 4; }  // keep
```
**Impact**: Blocks 6/10 rugs, costs 4/13 wins

#### 3. Add Sniper Wallet Count Hard Cap
In `autotrade.js` `autoBuy()`, add before buy:
```js
const sniperWallets = tokenData._walletTags?.sniper_wallets ?? tokenData.sniper_wallets ?? 0;
if (sniperWallets > 10) {
  console.log(`[AUTO] 🚨 ${symbol} BLOCKED: ${sniperWallets} sniper wallets`);
  return null;
}
```
**Impact**: Blocks 2/10 rugs (ONI with 29 snipers), costs 0/13 wins

#### 4. Add Duplicate Tweet Reference Tracking
In `autotrade.js`, track seen twitter URLs:
```js
const seenTwitterUrls = new Map(); // url → firstSeenTs
const TWITTER_DEDUP_WINDOW = 3600000; // 1 hour

// In autoBuy, before buying:
const twitterUrl = tokenData.twitter_username || '';
if (twitterUrl.includes('/status/')) {
  const existing = seenTwitterUrls.get(twitterUrl);
  if (existing && Date.now() - existing < TWITTER_DEDUP_WINDOW) {
    console.log(`[AUTO] 🚨 ${symbol} BLOCKED: duplicate tweet reference (${twitterUrl})`);
    return null;
  }
  seenTwitterUrls.set(twitterUrl, Date.now());
}
```
**Impact**: Blocks 3/10 rugs (AIAIAI cluster), costs 0-1/13 wins

### MEDIUM PRIORITY

#### 5. Enhance Entry Risk Score
```js
const entryRiskScore = (
  (entrapment < 0.05 ? 30 : 0) +
  (bundlerRate > 0.10 ? 30 : bundlerRate > 0.06 ? 15 : 0) +
  (liq < 30000 ? 20 : liq < 60000 ? 10 : 0) +
  (buyRatio > 3.0 && ageMin < 2 ? 15 : 0) +  // new: bot-inflated pressure
  (sniperWallets > 10 ? 15 : 0)                // new: sniper cluster
);
```

#### 6. Add Composite Risk Hard Block
```js
const bundlerIntensity = (tokenData.bundler_rate || 0) * buyRatio;
if (bundlerIntensity > 0.15) {
  console.log(`[AUTO] 🚨 ${symbol} BLOCKED: bundler intensity ${bundlerIntensity.toFixed(3)}`);
  return null;
}
```
**Impact**: Blocks 5/10 rugs, costs 4/13 wins

#### 7. Tighten Pre-buy Liquidity Recheck
Currently checks for >50% liq drop. Change to >30%:
```js
// In autotrade.js pre-buy check
if (screenerLiq > 0 && currentLiq < screenerLiq * 0.7) { // was 0.5
  // skip buy
}
```

---

## Expected Impact Summary

| Filter | Rugs Blocked | Wins Blocked | Net |
|--------|-------------|--------------|-----|
| BuyRatio age-aware | 4/10 | 2/13 | +2 saved |
| Bundler progressive | 6/10 | 4/13 | +2 saved |
| Sniper wallet cap >10 | 2/10 | 0/13 | +2 saved |
| Duplicate tweet dedup | 3/10 | 0-1/13 | +2-3 saved |
| Composite risk block | 5/10 | 4/13 | +1 saved |
| **Combined (non-overlapping)** | **~8/10** | **~5/13** | **+3 saved** |

The combined filter would reduce rug rate from 38% to ~12% while losing ~38% of wins. Given that average rug loss (-0.019 SOL) is 2.7x larger than average win gain (+0.007 SOL), this is a net positive trade.

**Recommended immediate actions**: Implement #1 (buyRatio age-aware), #3 (sniper wallet cap), and #4 (duplicate tweet dedup). These 3 have the best rug-blocked to wins-lost ratio.
