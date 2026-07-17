# Vector — autonomous trading cockpit

Vector is a small, dependency-free full-stack application for live crypto market monitoring and guarded Binance USDⓈ-M Futures execution. It intentionally keeps exchange credentials on the server, never handles seed phrases, and fails closed unless live trading is explicitly enabled.

## What is included

- Live Binance futures candles, mark price, 24h statistics and funding data.
- Wallet-first authentication using an EIP-4361-style, domain-bound one-time signature challenge; no passwords, private keys, or seed phrases are requested or stored.
- Server-side Binance HMAC request signing for account, positions, leverage, order preview, market orders and cancellation of open orders.
- Hard risk controls: symbol allowlist, leverage cap, notional cap, daily loss cap, minimum AI confidence, stop-loss requirement and a kill switch.
- Optional AI strategy endpoint using structured JSON output. AI output is only a proposal unless `AI_AUTO_EXECUTE=true`, and the hard risk engine runs again before any order.
- Live account/position refresh and an audit trail visible in the dashboard.
- Security headers, `HttpOnly`/`SameSite=Strict` sessions, explicit CSRF checks, no CORS, no localStorage secrets and no withdrawal API surface.

## Run locally

1. Copy `.env.example` to `.env`.
2. Open the app with an injected EVM wallet such as MetaMask, Coinbase Wallet, or Rabby. The wallet signs a human-readable login message; it does not send a transaction.
3. For live execution, create a Binance API key with only the permissions you need, disable withdrawals, restrict the key by IP, then set `BINANCE_API_KEY` and `BINANCE_API_SECRET`.
4. Start with `TRADING_MODE=disabled` or `TRADING_MODE=testnet`. Only set `TRADING_MODE=live` and `LIVE_TRADING_ACK=YES` after reviewing the code and the exchange account.
5. Run `npm start` and open `http://localhost:4173`.

The app requires no npm dependencies. Node 20+ is required for the built-in `fetch`; Node 22+ is recommended.

## Production hardening still required

This is an application foundation, not a promise that live-money trading is safe. Before production use, add TLS termination, an audited SIWE library/parser, a persistent encrypted audit store, centralized secrets management/KMS, rate limiting, an exchange user-data stream, monitoring/alerting, incident response, and an independent security/compliance review. Keep the live API key on a dedicated account with the smallest possible permissions.

The application does not invent prices, balances, fills or performance. If the upstream exchange or AI provider is unavailable, it shows an unavailable state and does not substitute mock values.

## Verification

Run `npm test` for the risk-engine regression suite. The repository also supports syntax checks with `node --check` on the server modules and `public/app.js`. Live smoke tests should use `/api/market/snapshot` and `/api/orders/preview`; the order endpoint must never be used as a health check.
