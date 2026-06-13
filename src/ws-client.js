const WebSocket = require('ws');

class PumpClient {
  constructor(wsUrl, onToken) {
    this.wsUrl = wsUrl;
    this.onToken = onToken;
    this.ws = null;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 30000;
    this.connected = false;
  }

  connect() {
    console.log(`[WS] Connecting to ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('[WS] Connected');
      this.connected = true;
      this.reconnectDelay = 2000;
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      console.log('[WS] Subscribed to newToken events');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.signature && msg.mint && msg.txType === 'create') {
          this.onToken(msg);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });

    this.ws.on('close', () => {
      console.log('[WS] Disconnected');
      this.connected = false;
      this._reconnect();
    });
  }

  _reconnect() {
    console.log(`[WS] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = PumpClient;
