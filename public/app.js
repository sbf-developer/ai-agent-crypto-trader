const $ = (selector) => document.querySelector(selector);
const state = { health: null, config: null, market: null, account: null, wallet: null, pricePoints: [], socket: null };

function formatPrice(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function formatCompact(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
function formatPercent(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—'; }
function formatTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function shortAddress(value) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'; }
function setText(selector, value) { const node = $(selector); if (node) node.textContent = value; }
function show(node, visible = true) { node?.classList.toggle('hidden', !visible); }
function makeElement(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }

async function api(path, options = {}) {
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('vector_csrf='))?.split('=').slice(1).join('=');
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
  return data;
}

function setFeedStatus(kind, text) { const node = $('#feedStatus'); node.className = `pill ${kind || 'pill-muted'}`; node.replaceChildren(makeElement('i'), document.createTextNode(text)); }
function renderWallet(address, chainId) {
  if (!address) return;
  const numericChainId = typeof chainId === 'string' && chainId.startsWith('0x') ? parseInt(chainId, 16) : Number(chainId);
  state.wallet = { address, chainId: numericChainId };
  setText('#walletAddress', address);
  setText('#walletChain', `Chain ${Number.isFinite(numericChainId) ? numericChainId : '—'}`);
  $('#walletBadge').className = 'badge badge-live';
  $('#walletBadge').textContent = 'CONNECTED';
  $('#walletButton').textContent = shortAddress(address);
}
function renderHealth(health) {
  state.health = health;
  const live = health.liveEnabled;
  const kill = health.killSwitch;
  const dot = $('.status-dot');
  dot.className = `status-dot ${live ? 'live' : kill ? 'error' : ''}`;
  setText('#systemCard strong', kill ? 'Kill switch enabled' : live ? 'Live execution enabled' : 'Execution locked');
  setText('#systemCard small', kill ? 'New orders blocked; open orders canceled.' : live ? 'Server checks and exchange connector are ready.' : 'Market feed is live; order execution is guarded.');
  setText('#marketSource', health.marketSource || '—');
  const liveBadge = $('#liveBadge'); liveBadge.className = `badge ${live ? 'badge-live' : kill ? 'badge-danger' : 'badge-muted'}`; liveBadge.textContent = kill ? 'KILL SWITCH' : live ? 'LIVE READY' : 'LOCKED';
  const aiBadge = $('#aiBadge'); aiBadge.className = `badge ${health.aiConfigured ? 'badge-live' : 'badge-muted'}`; aiBadge.textContent = health.aiConfigured ? 'READY' : 'NOT CONFIGURED';
  $('#executeButton').disabled = !live;
  if (health.walletAddress) renderWallet(health.walletAddress, health.walletChainId);
}

function renderMarket(market) {
  state.market = market;
  setText('#lastPrice', formatPrice(market.lastPrice));
  setText('#markPrice', formatPrice(market.markPrice));
  setText('#indexPrice', `Index ${formatPrice(market.indexPrice)}`);
  setText('#priceChange', formatPercent(market.priceChangePercent));
  $('#priceChange').classList.toggle('negative', Number(market.priceChangePercent) < 0);
  setText('#fundingRate', Number.isFinite(market.fundingRate) ? `${(market.fundingRate * 100).toFixed(4)}%` : '—');
  setText('#nextFunding', `Next funding ${market.nextFundingTime ? new Date(market.nextFundingTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}`);
  setText('#range', `${formatPrice(market.lowPrice)} — ${formatPrice(market.highPrice)}`);
  setText('#volume', `Volume ${formatCompact(market.volume)} BTC`);
  setText('#chartUpdated', `Updated ${formatTime(market.fetchedAt)}`);
  state.pricePoints = (market.candles || []).map((candle) => ({ time: candle.time, value: candle.close })).filter((point) => Number.isFinite(point.value));
  drawChart();
}

function drawChart() {
  const canvas = $('#priceChart'); const wrap = canvas?.parentElement; if (!canvas || !wrap) return;
  const rect = wrap.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr); canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); const width = rect.width; const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  const points = state.pricePoints; if (!points.length) { show($('#chartEmpty'), true); return; }
  show($('#chartEmpty'), false);
  const values = points.map((point) => point.value); const min = Math.min(...values); const max = Math.max(...values); const range = Math.max(max - min, max * .0004 || 1); const pad = { left: 14, right: 14, top: 22, bottom: 26 };
  ctx.strokeStyle = 'rgba(145,160,155,.14)'; ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i += 1) { const y = pad.top + ((height - pad.top - pad.bottom) * i / 5); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
  const xy = (point, index) => [pad.left + (index / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right), pad.top + (1 - (point.value - min) / range) * (height - pad.top - pad.bottom)];
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height); gradient.addColorStop(0, 'rgba(197,255,109,.22)'); gradient.addColorStop(1, 'rgba(197,255,109,0)');
  ctx.beginPath(); points.forEach((point, index) => { const [x, y] = xy(point, index); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); const lastX = xy(points.at(-1), points.length - 1)[0]; ctx.lineTo(lastX, height - pad.bottom); ctx.lineTo(pad.left, height - pad.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); points.forEach((point, index) => { const [x, y] = xy(point, index); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = '#c5ff6d'; ctx.lineWidth = 2; ctx.stroke();
  const last = xy(points.at(-1), points.length - 1); ctx.beginPath(); ctx.arc(last[0], last[1], 4, 0, Math.PI * 2); ctx.fillStyle = '#c5ff6d'; ctx.fill();
  ctx.fillStyle = '#5e6c68'; ctx.font = '10px ui-sans-serif'; ctx.fillText(formatPrice(max), pad.left, 13); ctx.fillText(formatPrice(min), pad.left, height - 7);
}

function startMarketSocket() {
  if (state.socket) state.socket.close();
  const symbol = (state.market?.symbol || state.config?.symbol || 'BTCUSDT').toLowerCase();
  try {
    state.socket = new WebSocket(`wss://fstream.binance.com/ws/${symbol}@markPrice@1s`);
    state.socket.onopen = () => setFeedStatus('live', 'Live mark feed');
    state.socket.onmessage = (event) => {
      const message = JSON.parse(event.data); const price = Number(message.p); if (!Number.isFinite(price)) return;
      if (state.market) { state.market.markPrice = price; state.market.lastPrice = price; }
      state.pricePoints.push({ time: Date.now(), value: price }); if (state.pricePoints.length > 180) state.pricePoints.shift();
      setText('#lastPrice', formatPrice(price)); setText('#markPrice', formatPrice(price)); drawChart();
    };
    state.socket.onerror = () => setFeedStatus('error', 'Live feed error');
    state.socket.onclose = () => { setFeedStatus('pill-muted', 'Reconnecting feed'); setTimeout(startMarketSocket, 5000); };
  } catch { setFeedStatus('error', 'WebSocket unavailable'); }
}

function renderConfig(config) {
  state.config = config;
  const select = $('#orderSymbol'); select.replaceChildren();
  for (const symbol of config.allowedSymbols || []) { const option = document.createElement('option'); option.value = symbol; option.textContent = symbol; option.selected = symbol === config.symbol; select.appendChild(option); }
  $('#orderLeverage').value = config.maxLeverage;
  $('#agentPrompt').value = config.agentPrompt || '';
  $('#riskRules').value = config.riskRules || '';
  $('#autoExecute').checked = Boolean(config.autoExecute);
  $('#autoExecute').disabled = !config.liveEnabled;
  setText('#killSwitchButton strong', config.killSwitch ? 'Disable kill switch' : 'Enable kill switch');
  setText('#killSwitchButton small', config.killSwitch ? 'Allow validated orders again' : 'Block new orders and cancel open orders');
  renderHealth({ ...state.health, killSwitch: config.killSwitch, liveEnabled: config.liveEnabled });
}

function renderAccount(account) {
  state.account = account;
  setText('#accountConnection', account.connected ? 'Connected' : 'Not connected');
  setText('#availableBalance', account.connected ? `${formatCompact(account.balances?.find((balance) => balance.asset === 'USDT')?.availableBalance)} USDT` : '—');
  setText('#positionCount', account.connected ? String(account.positions?.length || 0) : '—');
  const body = $('#positionsBody'); body.replaceChildren();
  if (!account.connected || !account.positions?.length) { const row = makeElement('tr'); const cell = makeElement('td', 'table-empty', 'No live positions returned by the exchange.'); cell.colSpan = 5; row.appendChild(cell); body.appendChild(row); return; }
  for (const position of account.positions) {
    const row = document.createElement('tr');
    for (const [value, className] of [[position.symbol, ''], [position.side, ''], [formatCompact(position.positionAmt), ''], [formatCompact(position.unrealizedPnl), Number(position.unrealizedPnl) >= 0 ? '' : 'negative'], [formatPrice(position.liquidationPrice), '']]) {
      row.appendChild(makeElement('td', className, String(value ?? '—')));
    }
    body.appendChild(row);
  }
}

function renderAudit(events = []) {
  const list = $('#auditList'); list.replaceChildren();
  if (!events.length) { list.appendChild(makeElement('div', 'table-empty', 'No activity recorded yet.')); return; }
  for (const event of events) {
    const item = makeElement('div', 'audit-item');
    const detail = Object.entries(event.detail || {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
    item.appendChild(makeElement('span', 'audit-time', formatTime(event.at)));
    const content = makeElement('div');
    content.appendChild(makeElement('div', 'audit-type', String(event.type || '').replaceAll('_', ' ')));
    content.appendChild(makeElement('div', 'audit-detail', detail || '—'));
    item.appendChild(content);
    list.appendChild(item);
  }
}

async function loadMarket() {
  try { renderMarket(await api(`/api/market/snapshot?symbol=${encodeURIComponent(state.config?.symbol || 'BTCUSDT')}&interval=1m&limit=120`)); setFeedStatus('live', 'Live market feed'); startMarketSocket(); }
  catch (error) { setFeedStatus('error', 'Market unavailable'); setText('#chartUpdated', error.message); }
}

async function loadPrivate() {
  try { renderConfig(await api('/api/config')); renderAccount(await api('/api/account')); renderAudit((await api('/api/audit')).events); $('#logoutButton').classList.remove('hidden'); $('#loginOverlay').classList.add('hidden'); }
  catch (error) { if (error.status === 401) $('#loginOverlay').classList.remove('hidden'); }
}

async function loadHealth() { try { renderHealth(await api('/api/health')); } catch { setText('#systemCard strong', 'Server unavailable'); } }

async function walletLogin() {
  setText('#loginError', '');
  if (!window.ethereum) { setText('#loginError', 'No injected EVM wallet was detected. Install MetaMask, Coinbase Wallet, or Rabby.'); return; }
  const button = $('#loginWalletButton'); if (button) { button.disabled = true; button.textContent = 'Waiting for wallet…'; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts?.[0];
    const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
    const chainId = parseInt(chainIdHex, 16);
    const challenge = await api('/api/auth/nonce', { method: 'POST', body: JSON.stringify({ address, chainId }) });
    if (button) button.textContent = 'Sign message in wallet…';
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, address] });
    const session = await api('/api/auth/wallet', { method: 'POST', body: JSON.stringify({ address, chainId, nonce: challenge.nonce, message: challenge.message, signature }) });
    renderWallet(session.address, session.chainId);
    await loadHealth(); await loadPrivate();
  } catch (error) { setText('#loginError', error.message || 'Wallet sign-in was rejected.'); }
  finally { if (button) { button.disabled = false; button.textContent = 'Connect wallet to continue'; } }
}

function formOrder() { return { symbol: $('#orderSymbol').value, side: $('#orderSide').value, type: $('#orderType').value, quantity: Number($('#orderQuantity').value), price: $('#orderType').value === 'LIMIT' ? Number($('#orderPrice').value) : null, leverage: Number($('#orderLeverage').value), stopLoss: $('#orderStop').value ? Number($('#orderStop').value) : null, takeProfit: $('#orderTake').value ? Number($('#orderTake').value) : null }; }
function showPreview(result, isError = false) { const node = $('#previewResult'); node.className = `inline-result ${isError ? 'error' : ''}`; node.textContent = result; show(node, true); }

async function previewOrder() { try { const result = await api('/api/orders/preview', { method: 'POST', body: JSON.stringify(formOrder()) }); showPreview(`Checks passed · estimated notional ${formatCompact(result.validation.normalized.notional)} USDT at ${formatPrice(result.validation.normalized.price)}.`); } catch (error) { showPreview(error.message, true); } }
async function submitOrder(event) { event.preventDefault(); if (!confirm('Submit this order to the configured exchange?')) return; try { const result = await api('/api/orders', { method: 'POST', body: JSON.stringify({ ...formOrder(), confirm: true }) }); showPreview(`Order submitted · exchange response ${result.response?.orderId || 'received'}.`); await refreshPrivate(); } catch (error) { showPreview(error.message, true); } }

async function saveAgentConfig() { try { state.config = await api('/api/config', { method: 'PATCH', body: JSON.stringify({ agentPrompt: $('#agentPrompt').value, riskRules: $('#riskRules').value, autoExecute: $('#autoExecute').checked }) }); renderConfig(state.config); } catch (error) { showDecisionError(error.message); } }
function showDecisionError(message) { const node = $('#decisionResult'); node.className = 'decision-result'; node.textContent = message; }
async function runAgent() {
  const button = $('#runAgentButton'); button.disabled = true; button.textContent = 'Evaluating…';
  try {
    await saveAgentConfig();
    const result = await api('/api/agent/run', { method: 'POST', body: '{}' });
    const decision = result.decision; const node = $('#decisionResult'); node.className = 'decision-result'; node.replaceChildren();
    const order = decision.order ? ` · ${decision.order.side} ${decision.order.quantity} ${state.config.symbol}` : '';
    const top = makeElement('div', 'decision-top'); top.appendChild(makeElement('span', 'decision-action', `${decision.action}${order}`)); top.appendChild(makeElement('span', 'decision-confidence', `Confidence ${(Number(decision.confidence) * 100).toFixed(0)}%`));
    node.appendChild(top); node.appendChild(makeElement('div', 'decision-rationale', decision.rationale || 'No rationale returned.'));
    node.appendChild(makeElement('div', 'audit-detail', `Invalidation: ${decision.invalidation || '—'}${result.execution?.ok ? ' · Executed after validation.' : result.proposalValidation?.errors?.length ? ` · Blocked: ${result.proposalValidation.errors.join(' ')}` : ''}`));
    await refreshPrivate();
  } catch (error) { showDecisionError(error.message); }
  finally { button.disabled = false; button.textContent = 'Run decision'; }
}

async function toggleKillSwitch() { const enabled = !state.config?.killSwitch; const verb = enabled ? 'Enable kill switch? This cancels open orders for the allowlisted symbols.' : 'Disable kill switch and allow validated orders again?'; if (!confirm(verb)) return; try { const result = await api('/api/kill-switch', { method: 'POST', body: JSON.stringify({ enabled }) }); state.config.killSwitch = result.killSwitch; renderConfig(state.config); } catch (error) { showPreview(error.message, true); } }
async function refreshPrivate() { try { renderAccount(await api('/api/account')); renderAudit((await api('/api/audit')).events); } catch (error) { if (error.status === 401) $('#loginOverlay').classList.remove('hidden'); } }

async function handleWalletContextChange() { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} location.reload(); }

function wire() {
  $('#loginWalletButton').addEventListener('click', walletLogin); $('#orderForm').addEventListener('submit', submitOrder); $('#previewButton').addEventListener('click', previewOrder); $('#runAgentButton').addEventListener('click', runAgent); $('#killSwitchButton').addEventListener('click', toggleKillSwitch); $('#walletButton').addEventListener('click', walletLogin); $('#refreshAccountButton').addEventListener('click', refreshPrivate); $('#refreshAuditButton').addEventListener('click', refreshPrivate); $('#logoutButton').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
  $('#orderType').addEventListener('change', () => show($('#limitPriceRow'), $('#orderType').value === 'LIMIT'));
  document.querySelectorAll('[data-side]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-side]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); $('#orderSide').value = button.dataset.side; }));
  window.addEventListener('resize', drawChart);
  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (accounts) => { if (state.wallet?.address && accounts[0]?.toLowerCase() !== state.wallet.address.toLowerCase()) handleWalletContextChange(); else if (accounts[0]) renderWallet(accounts[0], state.wallet?.chainId); else handleWalletContextChange(); });
    window.ethereum.on?.('chainChanged', () => { if (state.wallet?.address) handleWalletContextChange(); });
  }
}

async function boot() { wire(); await loadHealth(); await loadMarket(); await loadPrivate(); setInterval(loadMarket, 30_000); setInterval(refreshPrivate, 20_000); }
boot();
