const ORDER_SIDES = new Set(['BUY', 'SELL']);
const ORDER_TYPES = new Set(['MARKET', 'LIMIT']);

export function number(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function initialConfig() {
  const allowedSymbols = String(process.env.ALLOWED_SYMBOLS || 'BTCUSDT,ETHUSDT')
    .split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return {
    symbol: allowedSymbols[0] || 'BTCUSDT',
    allowedSymbols,
    maxLeverage: Math.max(1, number(process.env.MAX_LEVERAGE, 3)),
    maxNotionalUsdt: Math.max(1, number(process.env.MAX_NOTIONAL_USDT, 1000)),
    maxRiskPct: Math.min(100, Math.max(0.01, number(process.env.MAX_RISK_PCT, 1))),
    maxDailyLossUsdt: Math.max(1, number(process.env.MAX_DAILY_LOSS_USDT, 100)),
    minAiConfidence: Math.min(1, Math.max(0, number(process.env.MIN_AI_CONFIDENCE, 0.72))),
    killSwitch: false,
    autoExecute: String(process.env.AI_AUTO_EXECUTE).toLowerCase() === 'true',
    agentPrompt: 'Trade only when the setup is clear. Protect capital first. Prefer no trade over forcing a position.',
    riskRules: 'Never average down. Always use a protective stop. Do not trade during stale data, exchange errors, or when any hard limit would be exceeded.'
  };
}

export function validateOrder(order, config, market = {}) {
  const errors = [];
  const symbol = String(order?.symbol || '').toUpperCase();
  const side = String(order?.side || '').toUpperCase();
  const type = String(order?.type || 'MARKET').toUpperCase();
  const quantity = number(order?.quantity);
  const leverage = number(order?.leverage, 1);
  const price = number(order?.price, market.markPrice || market.lastPrice);
  const stopLoss = number(order?.stopLoss);
  const takeProfit = number(order?.takeProfit);

  if (!config.allowedSymbols.includes(symbol)) errors.push(`Symbol ${symbol || '(empty)'} is not in the allowlist.`);
  if (!ORDER_SIDES.has(side)) errors.push('Side must be BUY or SELL.');
  if (!ORDER_TYPES.has(type)) errors.push('Order type must be MARKET or LIMIT.');
  if (!quantity || quantity <= 0) errors.push('Quantity must be greater than zero.');
  if (type === 'LIMIT' && (!price || price <= 0)) errors.push('Limit orders require a positive price.');
  if (leverage < 1 || leverage > config.maxLeverage) errors.push(`Leverage must be between 1x and ${config.maxLeverage}x.`);
  if (!price || price <= 0) errors.push('A current market price is required to calculate risk.');

  const notional = quantity && price ? quantity * price : null;
  if (notional && notional > config.maxNotionalUsdt) errors.push(`Notional ${notional.toFixed(2)} USDT exceeds the ${config.maxNotionalUsdt.toFixed(2)} USDT cap.`);
  if (notional && notional * (config.maxRiskPct / 100) > config.maxDailyLossUsdt) errors.push('Configured risk per trade exceeds the daily loss cap.');
  if (notional && stopLoss !== null) {
    const estimatedLoss = quantity * Math.abs(price - stopLoss);
    const riskBudget = notional * (config.maxRiskPct / 100);
    if (estimatedLoss > riskBudget) errors.push(`Stop-loss distance implies ${estimatedLoss.toFixed(2)} USDT risk, above the ${riskBudget.toFixed(2)} USDT per-trade budget.`);
    if (estimatedLoss > config.maxDailyLossUsdt) errors.push('Estimated stop-loss risk exceeds the daily loss cap.');
  }

  if (stopLoss !== null) {
    if (side === 'BUY' && stopLoss >= price) errors.push('A BUY stop-loss must be below the entry reference.');
    if (side === 'SELL' && stopLoss <= price) errors.push('A SELL stop-loss must be above the entry reference.');
  }
  if (takeProfit !== null) {
    if (side === 'BUY' && takeProfit <= price) errors.push('A BUY take-profit must be above the entry reference.');
    if (side === 'SELL' && takeProfit >= price) errors.push('A SELL take-profit must be below the entry reference.');
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: { symbol, side, type, quantity, leverage, price, stopLoss, takeProfit, notional }
  };
}

export function validateConfigPatch(patch, current) {
  const next = { ...current };
  const errors = [];
  if (patch.symbol !== undefined) {
    const symbol = String(patch.symbol).toUpperCase();
    if (!current.allowedSymbols.includes(symbol)) errors.push('Selected symbol is not in the allowlist.');
    else next.symbol = symbol;
  }
  const hardCaps = {
    maxLeverage: number(process.env.MAX_LEVERAGE, 3),
    maxNotionalUsdt: number(process.env.MAX_NOTIONAL_USDT, 1000),
    maxRiskPct: number(process.env.MAX_RISK_PCT, 1),
    maxDailyLossUsdt: number(process.env.MAX_DAILY_LOSS_USDT, 100),
    minAiConfidence: number(process.env.MIN_AI_CONFIDENCE, 0.72)
  };
  for (const [key, min, max] of [
    ['maxLeverage', 1, hardCaps.maxLeverage],
    ['maxNotionalUsdt', 1, hardCaps.maxNotionalUsdt],
    ['maxRiskPct', 0.01, hardCaps.maxRiskPct],
    ['maxDailyLossUsdt', 1, hardCaps.maxDailyLossUsdt],
    ['minAiConfidence', hardCaps.minAiConfidence, 1]
  ]) {
    if (patch[key] === undefined) continue;
    const value = number(patch[key]);
    if (value === null || value < min || value > max) errors.push(`${key} is outside its allowed range.`);
    else next[key] = value;
  }
  if (patch.agentPrompt !== undefined) next.agentPrompt = String(patch.agentPrompt).slice(0, 2000);
  if (patch.riskRules !== undefined) next.riskRules = String(patch.riskRules).slice(0, 3000);
  if (patch.autoExecute !== undefined) next.autoExecute = Boolean(patch.autoExecute);
  return { ok: errors.length === 0, errors, next };
}

export function isLiveTradingEnabled(config, exchangeConfigured) {
  return process.env.TRADING_MODE === 'live'
    && process.env.LIVE_TRADING_ACK === 'YES'
    && exchangeConfigured
    && !config.killSwitch;
}
