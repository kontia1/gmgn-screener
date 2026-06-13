const https = require('https');

class TelegramNotifier {
  constructor(botToken, chatId, parseMode = 'HTML') {
    this.botToken = botToken;
    this.chatId = chatId;
    this.parseMode = parseMode;
    this.lastSent = 0;
    this.cooldownMs = 3000;
    this.sentCount = 0;
    this.hourlyLimit = 60;
    this.hourStart = Date.now();
  }

  /**
   * Send token creation alert with quality score
   * @param {Object} token - raw WS data
   * @param {Object|null} metadata - fetched metadata
   * @param {number} score - quality score
   * @param {string[]} signals - quality signals
   * @param {Object|null} dexData - DexScreener real-time data
   */
  async sendAlert(token, metadata, score, signals, dexData) {
    if (!this._canSend()) {
      console.log('[TG] Rate limited, skipping');
      return false;
    }

    const msg = this._formatCreationAlert(token, metadata, score, signals, dexData);
    try {
      const result = await this._sendMessage(msg);
      if (result) {
        this.lastSent = Date.now();
        this.sentCount++;
        console.log(`[TG] Sent alert for ${token.symbol || token.mint.slice(0, 8)}`);
        return true;
      }
    } catch (e) {
      console.error('[TG] Send error:', e.message);
    }
    return false;
  }

  async sendText(text) {
    if (!this._canSend()) return false;
    try {
      const result = await this._sendMessage(text);
      if (result) {
        this.lastSent = Date.now();
        this.sentCount++;
      }
      return result;
    } catch (e) {
      console.error('[TG] Send error:', e.message);
      return false;
    }
  }

  _formatCreationAlert(token, meta, score, signals, dex) {
    const creator = token.traderPublicKey;
    const shortCreator = `${creator.slice(0, 6)}...${creator.slice(-4)}`;
    const mayhem = token.is_mayhem_mode ? 'YES' : 'No';

    // Score bar
    const filled = Math.round(score / 10);
    const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const scoreEmoji = score >= 70 ? '🟢' : score >= 50 ? '🟡' : '🟠';

    // Use DexScreener data if available and valid, otherwise fallback to WS data
    const wsMcUsd = ((token.marketCapSol || 0) * 150).toFixed(0);
    const mcUsd = dex?.mcUsd > 0 ? `$${this._formatUsd(dex.mcUsd)}` : `~$${wsMcUsd}`;
    const liqUsd = dex?.liqUsd > 0 ? `$${this._formatUsd(dex.liqUsd)}` : 'N/A';
    const priceUsd = dex?.priceUsd > 0 ? `$${dex.priceUsd.toFixed(8)}` : 'N/A';
    const vol1h = dex?.volume1h > 0 ? `$${this._formatUsd(dex.volume1h)}` : 'N/A';
    const buyRatio = dex?.buyRatio != null && dex.h1Buys + dex.h1Sells > 0 ? `${(dex.buyRatio * 100).toFixed(0)}%` : 'N/A';

    const solSpent = token.solAmount.toFixed(3);
    const initialBuy = this._formatNumber(token.initialBuy);

    let lines = [];
    lines.push(`<b>🪙 New Token Found</b>`);
    lines.push('');
    lines.push(`<b>${this._esc(meta?.name || token.name || 'Unknown')}</b> (${this._esc(meta?.symbol || token.symbol || '?')})`);
    lines.push('');
    lines.push(`<code>${token.mint}</code>`);
    lines.push('');
    lines.push(`${scoreEmoji} Quality: <b>${score}/100</b> ${scoreBar}`);
    lines.push('');
    lines.push(`💰 Price: <b>${priceUsd}</b>`);
    lines.push(`📊 MC: <b>${mcUsd}</b>`);
    lines.push(`💧 Liq: <b>${liqUsd}</b>`);
    lines.push(`📈 Vol 1h: <b>${vol1h}</b>`);
    lines.push(`📊 Buy Ratio 1h: <b>${buyRatio}</b>`);
    lines.push('');
    lines.push(`💎 Creator Spend: <b>${solSpent} SOL</b>`);
    lines.push(`📊 Initial Buy: <b>${initialBuy}</b> tokens`);
    lines.push(`🔥 Mayhem: ${mayhem}`);
    lines.push(`👤 Creator: <code>${shortCreator}</code>`);
    lines.push('');

    // Signals
    if (signals && signals.length > 0) {
      lines.push(`<b>Signals:</b>`);
      for (const s of signals) {
        lines.push(`  ${s}`);
      }
      lines.push('');
    }

    // Description
    if (meta?.description) {
      const desc = meta.description.length > 200
        ? meta.description.slice(0, 200) + '...'
        : meta.description;
      lines.push(`📝 ${this._esc(desc)}`);
      lines.push('');
    }

    // Links
    const links = [];
    if (meta?.website) links.push(`🌐 ${meta.website}`);
    if (meta?.twitter) {
      const handle = meta.twitter.replace('@', '');
      links.push(`🐦 https://x.com/${handle}`);
    }
    if (meta?.telegram) {
      const t = meta.telegram.replace('@', '').replace('https://t.me/', '');
      links.push(`📱 https://t.me/${t}`);
    }
    if (links.length > 0) {
      lines.push(links.join('\n'));
      lines.push('');
    }

    lines.push(`🔗 https://pump.fun/coin/${token.mint}`);

    return lines.join('\n');
  }

  _canSend() {
    if (Date.now() - this.lastSent < this.cooldownMs) return false;
    if (Date.now() - this.hourStart > 3600000) {
      this.hourStart = Date.now();
      this.sentCount = 0;
    }
    if (this.sentCount >= this.hourlyLimit) return false;
    return true;
  }

  _sendMessage(text) {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        chat_id: this.chatId,
        text: text,
        parse_mode: this.parseMode,
        disable_web_page_preview: true
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ok === true);
          } catch {
            resolve(false);
          }
        });
      });

      req.on('error', (e) => {
        console.error('[TG] Request error:', e.message);
        resolve(false);
      });

      req.write(body);
      req.end();
    });
  }

  _formatNumber(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(2);
  }

  _formatUsd(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  _esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

module.exports = TelegramNotifier;
