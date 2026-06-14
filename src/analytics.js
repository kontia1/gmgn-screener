/**
 * Analytics logging for GMGN screener bot
 * Logs buy/reject/skip decisions to JSON for data collection
 * No external deps — just fs + path
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'analytics');
const DECISIONS_FILE = path.join(DATA_DIR, 'decisions.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDecisions() {
  try {
    if (!fs.existsSync(DECISIONS_FILE)) return [];
    const raw = fs.readFileSync(DECISIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeDecisions(entries) {
  ensureDir();
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(entries, null, 2));
}

function cleanupOld(entries) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return entries.filter(e => e.timestamp > cutoff);
}

/**
 * Log a decision entry
 * @param {Object} entry - { token, address, source, baseScore, minScore, confidence, wallets, decision, reason, price, mc, ageMin }
 */
function logDecision(entry) {
  try {
    let entries = readDecisions();
    entries = cleanupOld(entries);
    entries.push({
      timestamp: Date.now(),
      token: entry.token || '',
      address: entry.address || '',
      source: entry.source || '',
      baseScore: entry.baseScore ?? 0,
      minScore: entry.minScore ?? 0,
      confidence: entry.confidence || '',
      wallets: entry.wallets ?? 0,
      decision: entry.decision || 'unknown',
      reason: entry.reason || '',
      price: entry.price ?? 0,
      mc: entry.mc ?? 0,
      ageMin: entry.ageMin ?? 0,
    });
    writeDecisions(entries);
  } catch (e) {
    console.error('[Analytics] logDecision failed:', e.message);
  }
}

/**
 * Get decisions with optional filter
 * @param {Object} [filter] - { decision?, source?, since?, token? }
 * @returns {Array}
 */
function getDecisions(filter) {
  try {
    let entries = readDecisions();
    entries = cleanupOld(entries);
    if (!filter) return entries;
    if (filter.decision) entries = entries.filter(e => e.decision === filter.decision);
    if (filter.source) entries = entries.filter(e => e.source === filter.source);
    if (filter.token) entries = entries.filter(e => e.token === filter.token);
    if (filter.since) entries = entries.filter(e => e.timestamp >= filter.since);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Get performance summary
 * @returns {Object}
 */
function getPerformanceSummary() {
  try {
    const entries = cleanupOld(readDecisions());
    const buys = entries.filter(e => e.decision === 'buy');
    const rejects = entries.filter(e => e.decision === 'reject');
    const skips = entries.filter(e => e.decision === 'skip');

    const bySource = {};
    for (const e of entries) {
      if (!bySource[e.source]) bySource[e.source] = { buy: 0, reject: 0, skip: 0, total: 0 };
      bySource[e.source][e.decision] = (bySource[e.source][e.decision] || 0) + 1;
      bySource[e.source].total++;
    }

    const avgScore = (arr) => arr.length ? arr.reduce((s, e) => s + e.baseScore, 0) / arr.length : 0;

    return {
      total: entries.length,
      buys: buys.length,
      rejects: rejects.length,
      skips: skips.length,
      avgBuyScore: avgScore(buys),
      avgRejectScore: avgScore(rejects),
      bySource,
      oldestEntry: entries.length ? new Date(entries[0].timestamp).toISOString() : null,
      newestEntry: entries.length ? new Date(entries[entries.length - 1].timestamp).toISOString() : null,
    };
  } catch {
    return { total: 0, buys: 0, rejects: 0, skips: 0, bySource: {} };
  }
}

module.exports = { logDecision, getDecisions, getPerformanceSummary };
