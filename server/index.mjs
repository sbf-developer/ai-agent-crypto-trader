import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, randomToken, parseCookies, sessionCookie, csrfCookie, clearSessionCookie, timingSafeEqualText } from './security.mjs';
import { BinanceClient } from './binance.mjs';
import { initialConfig, validateConfigPatch, validateOrder, isLiveTradingEnabled, number } from './risk.mjs';
import { getAiDecision } from './agent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4173);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const publicDir = path.join(ROOT, 'public');
const config = initialConfig();
const sessions = new Map();
const nonces = new Map();
const audit = [];
const rateBuckets = new Map();

const exchange = new BinanceClient({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  baseUrl: process.env.BINANCE_BASE_URL || 'https://fapi.binance.com',
  marketBase: process.env.MARKET_API_BASE || 'https://fapi.binance.com',
  recvWindow: process.env.BINANCE_RECV_WINDOW || 5000
});

function logEvent(type, detail = {}) {
  audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), type, detail });
  if (audit.length > 100) audit.length = 100;
}

function authRequired() {
  return !(process.env.NODE_ENV !== 'production' && process.env.AUTH_DISABLED === 'true');
}

function authConfigured() {
  return Boolean(process.env.APP_USERNAME && process.env.APP_PASSWORD);
}

function cleanError(error) {
  return error?.message || 'Unexpected server error.';
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}

function securityHeaders(contentType) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://fapi.binance.com https://data-api.binance.vision wss://fstream.binance.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
  if (process.env.NODE_ENV === 'production') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function getSession(request) {
  if (!authRequired()) return { id: 'dev-bypass', username: 'dev' };
  const token = parseCookies(request.headers.cookie).vector_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return null;
  }
  return session;
}

function requireCsrf(request, response, session) {
  if (!authRequired()) return true;
  const token = request.headers['x-csrf-token'];
  if (!session?.csrf || !token || !timingSafeEqualText(token, session.csrf)) {
    sendJson(response, 403, { error: 'CSRF validation failed. Refresh the session and try again.' });
    return false;
  }
  return true;
}

function rateLimit(request, response, bucket = 'default', limit = 60, windowMs = 60_000) {
  const address = request.socket.remoteAddress || 'local';
  const key = `${address}:${bucket}`;
  const now = Date.now();
  const current = rateBuckets.get(key) || { count: 0, start: now };
  if (now - current.start > windowMs) { current.count = 0; current.start = now; }
  current.count += 1;
  rateBuckets.set(key, current);
  if (current.count > limit) {
    sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': '60' });
    return false;
  }
  return true;
}

async function marketSnapshot(symbol = config.symbol, interval = '1m', limit = 120) {
  const safeSymbol = String(symbol).toUpperCase();
  if (!config.allowedSymbols.includes(safeSymbol)) throw new Error('Symbol is not allowed.');
  const safeLimit = Math.min(500, Math.max(20, Number(limit) || 120));
  const [candles, ticker, mark] = await Promise.all([
    exchange.klines(safeSymbol, interval, safeLimit),
    exchange.ticker(safeSymbol),
    exchange.markPrice(safeSymbol)
  ]);
  return {
    symbol: safeSymbol,
    interval,
    candles: Array.isArray(candles) ? candles.map((candle) => ({
      time: Number(candle[0]), open: Number(candle[1]), high: Number(candle[2]), low: Number(candle[3]), close: Number(candle[4]), volume: Number(candle[5])
    })) : [],
    lastPrice: Number(ticker.lastPrice),
    priceChangePercent: Number(ticker.priceChangePercent),
    highPrice: Number(ticker.highPrice),
    lowPrice: Number(ticker.lowPrice),
    volume: Number(ticker.volume),
    markPrice: Number(mark.markPrice),
    indexPrice: Number(mark.indexPrice),
    fundingRate: Number(mark.lastFundingRate),
    nextFundingTime: Number(mark.nextFundingTime),
    source: 'Binance USDⓈ-M Futures',
    fetchedAt: new Date().toISOString()
  };
}

async function accountSnapshot() {
  if (!exchange.configured) return { connected: false, reason: 'Exchange credentials are not configured.' };
  try { return { connected: true, ...await exchange.accountSnapshot() }; }
  catch (error) { return { connected: false, reason: cleanError(error) }; }
}

function statusPayload(request) {
  const liveEnabled = isLiveTradingEnabled(config, exchange.configured);
  return {
    ok: true,
    authRequired: authRequired(),
    authConfigured: authConfigured(),
    authenticated: Boolean(getSession(request)),
    exchangeConfigured: exchange.configured,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    tradingMode: process.env.TRADING_MODE || 'disabled',
    liveEnabled,
    killSwitch: config.killSwitch,
    marketSource: 'Binance USDⓈ-M Futures',
    serverTime: new Date().toISOString()
  };
}

function jsonSafeOrder(order) {
  return {
    symbol: String(order.symbol || '').toUpperCase(),
    side: String(order.side || '').toUpperCase(),
    type: String(order.type || 'MARKET').toUpperCase(),
    quantity: number(order.quantity),
    price: number(order.price),
    leverage: number(order.leverage, 1),
    stopLoss: number(order.stopLoss),
    takeProfit: number(order.takeProfit)
  };
}

async function executeOrder(order, source = 'manual') {
  const safeOrder = jsonSafeOrder(order);
  const market = await marketSnapshot(safeOrder.symbol, '1m', 20);
  const validation = validateOrder(safeOrder, config, market);
  if (!validation.ok) {
    logEvent('order_rejected', { source, errors: validation.errors });
    return { ok: false, status: 400, errors: validation.errors, validation };
  }
  if (!isLiveTradingEnabled(config, exchange.configured)) {
    logEvent('order_blocked', { source, reason: config.killSwitch ? 'kill_switch' : 'live_trading_not_enabled' });
    return { ok: false, status: 409, errors: ['Live trading is not enabled. Configure the exchange, set TRADING_MODE=live, acknowledge LIVE_TRADING_ACK=YES, and ensure the kill switch is off.'], validation };
  }
  if (!validation.normalized.stopLoss) {
    logEvent('order_rejected', { source, errors: ['A protective stop-loss is required for every live entry order.'] });
    return { ok: false, status: 400, errors: ['A protective stop-loss is required for every live entry order.'], validation };
  }

  const params = {
    symbol: validation.normalized.symbol,
    side: validation.normalized.side,
    type: validation.normalized.type,
    quantity: validation.normalized.quantity,
    newOrderRespType: 'RESULT'
  };
  if (validation.normalized.type === 'LIMIT') {
    params.timeInForce = 'GTC';
    params.price = validation.normalized.price;
  }
  const results = [];
  const protection = { stopLoss: null, takeProfit: null, ok: false };
  try {
    results.push(await exchange.changeLeverage(validation.normalized.symbol, validation.normalized.leverage));
    const response = await exchange.newOrder(params);
    const closeSide = validation.normalized.side === 'BUY' ? 'SELL' : 'BUY';
    try {
      protection.stopLoss = await exchange.protectiveOrder({
        symbol: validation.normalized.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: validation.normalized.stopLoss
      });
      if (validation.normalized.takeProfit) {
        protection.takeProfit = await exchange.protectiveOrder({
          symbol: validation.normalized.symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: validation.normalized.takeProfit
        });
      }
      protection.ok = true;
    } catch (protectionError) {
      protection.error = cleanError(protectionError);
      logEvent('protection_error', { source, error: protection.error, symbol: validation.normalized.symbol });
    }
    logEvent('order_submitted', { source, symbol: params.symbol, side: params.side, type: params.type, quantity: params.quantity });
    return { ok: protection.ok, response, protection, validation, errors: protection.ok ? [] : ['The entry was accepted but the protective order could not be confirmed. Review the account immediately and use the kill switch.'] };
  } catch (error) {
    logEvent('order_error', { source, error: cleanError(error) });
    return { ok: false, status: error.status || 502, errors: [cleanError(error)], validation, results };
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const method = request.method || 'GET';

  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, statusPayload(request));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    if (!rateLimit(request, response, 'login', 10)) return;
    if (!authConfigured()) {
      sendJson(response, 503, { error: 'APP_USERNAME and APP_PASSWORD are not configured. Copy .env.example to .env first.' });
      return;
    }
    const body = await bodyJson(request);
    if (!timingSafeEqualText(body.username, process.env.APP_USERNAME) || !timingSafeEqualText(body.password, process.env.APP_PASSWORD)) {
      logEvent('login_failed');
      sendJson(response, 401, { error: 'Invalid credentials.' });
      return;
    }
    const token = randomToken(32);
    const csrf = randomToken(24);
    sessions.set(token, { id: token.slice(0, 12), username: process.env.APP_USERNAME, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    logEvent('login_success', { username: process.env.APP_USERNAME });
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': [sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)), csrfCookie(csrf, Math.floor(SESSION_TTL_MS / 1000))] });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = getSession(request);
    if (session && !requireCsrf(request, response, session)) return;
    const token = parseCookies(request.headers.cookie).vector_session;
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/market/snapshot') {
    if (!rateLimit(request, response, 'market', 120, 60_000)) return;
    try {
      const snapshot = await marketSnapshot(url.searchParams.get('symbol') || config.symbol, url.searchParams.get('interval') || '1m', url.searchParams.get('limit') || 120);
      sendJson(response, 200, snapshot);
    } catch (error) { sendJson(response, error.status || 502, { error: cleanError(error), source: 'Binance USDⓈ-M Futures' }); }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/config') {
    if (!requireSession(request, response)) return;
    sendJson(response, 200, { ...config, liveEnabled: isLiveTradingEnabled(config, exchange.configured) });
    return;
  }

  if (method === 'PATCH' && url.pathname === '/api/config') {
    const session = requireSession(request, response);
    if (!session || !requireCsrf(request, response, session)) return;
    const body = await bodyJson(request);
    const updated = validateConfigPatch(body, config);
    if (!updated.ok) { sendJson(response, 400, { error: updated.errors.join(' ') }); return; }
    if (updated.next.autoExecute && !isLiveTradingEnabled(updated.next, exchange.configured)) {
      sendJson(response, 409, { error: 'Auto-execution can only be enabled while live trading is explicitly enabled and the kill switch is off.' });
      return;
    }
    Object.assign(config, updated.next);
    logEvent('config_updated', { fields: Object.keys(body) });
    sendJson(response, 200, { ...config, liveEnabled: isLiveTradingEnabled(config, exchange.configured) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/account') {
    if (!requireSession(request, response)) return;
    sendJson(response, 200, await accountSnapshot());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/audit') {
    if (!requireSession(request, response)) return;
    sendJson(response, 200, { events: audit.slice(0, 50) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orders/preview') {
    const session = requireSession(request, response);
    if (!session || !requireCsrf(request, response, session)) return;
    const order = jsonSafeOrder(await bodyJson(request));
    try {
      const market = await marketSnapshot(order.symbol, '1m', 20);
      const validation = validateOrder(order, config, market);
      logEvent(validation.ok ? 'order_preview' : 'order_preview_rejected', { symbol: order.symbol, side: order.side, errors: validation.errors });
      sendJson(response, validation.ok ? 200 : 400, { ok: validation.ok, validation, market: { lastPrice: market.lastPrice, markPrice: market.markPrice } });
    } catch (error) { sendJson(response, error.status || 502, { error: cleanError(error) }); }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orders') {
    const session = requireSession(request, response);
    if (!session || !requireCsrf(request, response, session)) return;
    const body = await bodyJson(request);
    if (body.confirm !== true) { sendJson(response, 400, { error: 'Explicit order confirmation is required.' }); return; }
    const result = await executeOrder(body, 'manual');
    sendJson(response, result.ok ? 200 : (result.status || 400), result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/kill-switch') {
    const session = requireSession(request, response);
    if (!session || !requireCsrf(request, response, session)) return;
    const body = await bodyJson(request);
    const enabled = body.enabled !== false;
    config.killSwitch = enabled;
    let canceled = [];
    if (enabled && exchange.configured) {
      for (const symbol of config.allowedSymbols) {
        try { canceled.push({ symbol, response: await exchange.cancelAll(symbol) }); }
        catch (error) { canceled.push({ symbol, error: cleanError(error) }); }
      }
    }
    logEvent(enabled ? 'kill_switch_enabled' : 'kill_switch_disabled', { canceledSymbols: canceled.map((item) => item.symbol) });
    sendJson(response, 200, { ok: true, killSwitch: config.killSwitch, canceled });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/agent/run') {
    const session = requireSession(request, response);
    if (!session || !requireCsrf(request, response, session)) return;
    if (!rateLimit(request, response, 'agent', 10, 60_000)) return;
    try {
      const market = await marketSnapshot(config.symbol, '1m', 120);
      const account = exchange.configured ? await accountSnapshot() : { connected: false };
      const result = await getAiDecision({ market, config, account });
      const decision = result.decision;
      let proposalValidation = null;
      let execution = null;
      if (decision.order) {
        const proposedOrder = { ...decision.order, symbol: config.symbol };
        proposalValidation = validateOrder(proposedOrder, config, market);
        if (Number(decision.confidence) < config.minAiConfidence) {
          proposalValidation.ok = false;
          proposalValidation.errors.push(`AI confidence is below the ${config.minAiConfidence} threshold.`);
        }
        if (config.killSwitch) {
          proposalValidation.ok = false;
          proposalValidation.errors.push('Kill switch is enabled.');
        }
        if (config.autoExecute && proposalValidation.ok) execution = await executeOrder(proposedOrder, 'ai');
      }
      logEvent('agent_run', { action: decision.action, confidence: decision.confidence, execution: execution?.ok || false });
      sendJson(response, 200, { ok: true, market, ...result, proposalValidation, execution });
    } catch (error) {
      logEvent('agent_error', { error: cleanError(error) });
      sendJson(response, error.code === 'AI_NOT_CONFIGURED' ? 503 : 502, { error: cleanError(error) });
    }
    return;
  }

  if (method === 'GET') {
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(publicDir, `.${requested}`);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    const ext = path.extname(filePath);
    const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
    response.writeHead(200, securityHeaders(contentType));
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

const server = http.createServer(async (request, response) => {
  try { await route(request, response); }
  catch (error) { sendJson(response, error.status || 500, { error: cleanError(error) }); }
});

server.listen(PORT, () => {
  console.log(`Vector trading cockpit listening on http://localhost:${PORT}`);
  console.log(`Live execution: ${isLiveTradingEnabled(config, exchange.configured) ? 'ENABLED' : 'disabled'}`);
  if (!authConfigured() && authRequired()) console.warn('Set APP_USERNAME and APP_PASSWORD before using protected controls.');
});
