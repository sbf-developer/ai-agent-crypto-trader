import test from 'node:test';
import assert from 'node:assert/strict';
import { initialConfig, validateConfigPatch, validateOrder } from '../server/risk.mjs';

process.env.MAX_LEVERAGE = '3';
process.env.MAX_NOTIONAL_USDT = '1000';
process.env.MAX_RISK_PCT = '1';
process.env.MAX_DAILY_LOSS_USDT = '100';
process.env.MIN_AI_CONFIDENCE = '0.72';

test('valid order uses live market price when price is omitted', () => {
  const config = initialConfig();
  const result = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, leverage: 3, stopLoss: 63500 }, config, { markPrice: 64000 });
  assert.equal(result.ok, true);
  assert.equal(result.normalized.price, 64000);
});

test('risk engine rejects leverage above immutable environment cap', () => {
  const config = initialConfig();
  const result = validateConfigPatch({ maxLeverage: 4 }, config);
  assert.equal(result.ok, false);
});

test('risk engine rejects a stop distance above the per-trade budget', () => {
  const config = initialConfig();
  const result = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01, leverage: 3, stopLoss: 50000 }, config, { markPrice: 64000 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /risk/i);
});

test('risk engine rejects symbols outside the allowlist', () => {
  const config = initialConfig();
  const result = validateOrder({ symbol: 'DOGEUSDT', side: 'BUY', type: 'MARKET', quantity: 1, leverage: 1, stopLoss: 0.1 }, config, { markPrice: 0.2 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /allowlist/i);
});
