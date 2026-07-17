import crypto from 'node:crypto';

const DEFAULT_BASE = 'https://fapi.binance.com';
const DEFAULT_MARKET_BASE = 'https://fapi.binance.com';

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { msg: text }; }
    if (!response.ok) {
      const error = new Error(payload?.msg || `Upstream request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export class BinanceClient {
  constructor({ apiKey = '', apiSecret = '', baseUrl = DEFAULT_BASE, marketBase = DEFAULT_MARKET_BASE, recvWindow = 5000 } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.marketBase = marketBase.replace(/\/$/, '');
    this.recvWindow = Number(recvWindow) || 5000;
  }

  get configured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  async publicGet(path, params = {}) {
    const query = new URLSearchParams(params);
    const url = `${this.marketBase}${path}${query.toString() ? `?${query}` : ''}`;
    return fetchWithTimeout(url);
  }

  async signed(method, path, params = {}) {
    if (!this.configured) throw new Error('Exchange credentials are not configured on the server.');
    const signedParams = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, recvWindow: this.recvWindow, timestamp: Date.now() })) {
      if (value !== undefined && value !== null && value !== '') signedParams.set(key, String(value));
    }
    const payload = signedParams.toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');
    signedParams.set('signature', signature);
    const url = `${this.baseUrl}${path}?${signedParams.toString()}`;
    return fetchWithTimeout(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'vector-trading-cockpit/0.1'
      }
    });
  }

  ticker(symbol) { return this.publicGet('/fapi/v1/ticker/24hr', { symbol }); }
  markPrice(symbol) { return this.publicGet('/fapi/v1/premiumIndex', { symbol }); }
  klines(symbol, interval = '1m', limit = 120) { return this.publicGet('/fapi/v1/klines', { symbol, interval, limit }); }
  exchangeInfo() { return this.publicGet('/fapi/v1/exchangeInfo'); }

  async accountSnapshot() {
    const [balances, positions, openOrders] = await Promise.all([
      this.signed('GET', '/fapi/v2/balance'),
      this.signed('GET', '/fapi/v2/positionRisk'),
      this.signed('GET', '/fapi/v1/openOrders')
    ]);
    return {
      balances: Array.isArray(balances) ? balances.map((item) => ({
        asset: item.asset,
        balance: asNumber(item.balance),
        availableBalance: asNumber(item.availableBalance),
        crossWalletBalance: asNumber(item.crossWalletBalance)
      })) : [],
      positions: Array.isArray(positions) ? positions.filter((item) => Number(item.positionAmt) !== 0).map((item) => ({
        symbol: item.symbol,
        side: item.positionSide || 'BOTH',
        positionAmt: asNumber(item.positionAmt),
        entryPrice: asNumber(item.entryPrice),
        markPrice: asNumber(item.markPrice),
        unrealizedPnl: asNumber(item.unRealizedProfit),
        liquidationPrice: asNumber(item.liquidationPrice),
        leverage: asNumber(item.leverage),
        marginType: item.marginType
      })) : [],
      openOrders: Array.isArray(openOrders) ? openOrders.map((item) => ({
        orderId: item.orderId,
        symbol: item.symbol,
        side: item.side,
        type: item.type,
        status: item.status,
        price: asNumber(item.price),
        origQty: asNumber(item.origQty),
        executedQty: asNumber(item.executedQty),
        stopPrice: asNumber(item.stopPrice),
        updateTime: item.updateTime
      })) : []
    };
  }

  changeLeverage(symbol, leverage) {
    return this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  newOrder(params) {
    return this.signed('POST', '/fapi/v1/order', params);
  }

  protectiveOrder({ symbol, side, stopPrice, type }) {
    return this.signed('POST', '/fapi/v1/order', {
      symbol,
      side,
      type,
      stopPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      priceProtect: 'TRUE',
      newOrderRespType: 'RESULT'
    });
  }

  cancelAll(symbol) {
    return this.signed('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }
}

export { asNumber };
