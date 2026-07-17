const https  = require("https");
const crypto = require("crypto");

/* const {
  handleGetSettings, handlePutSettings,
  handlePostTransaction, handleGetTransactions,
  handleSubscribe, handleStripeWebhook, handleUserCreated,
} = require("./proxy_auth_middleware"); */

const NEWSDATA_HOST = "newsdata.io";
const NEWSDATA_KEY  = "pub_7e39169f4e394355a99f1f06ca08b392";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Content-Type": "application/json",
};

// ── Generic HTTPS helpers ─────────────────────────────────────────────────────
function httpsRequest(method, host, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;
    const req = https.request(
      {
        hostname: host, path, method,
        headers: {
          Accept: "application/json",
          "User-Agent": "crypto-proxy/2.0",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
const httpsGet  = (host, path, headers)       => httpsRequest("GET",  host, path, headers);
const httpsPost = (host, path, headers, body) => httpsRequest("POST", host, path, headers, body);

// ── Read POST body from Cloud Run request ─────────────────────────────────────
// Cloud Run may pre-parse the body onto req.body, or stream it raw.
// We handle both cases.
function readBody(req) {
  // Cloud Run Functions Framework pre-parses JSON bodies onto req.body
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return Promise.resolve(req.body);
    if (typeof req.body === "string") {
      try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
    }
  }
  // Fall back to reading raw stream
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch { resolve({}); }
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// PRICE FETCHERS  (public endpoints — no auth needed)
// ═════════════════════════════════════════════════════════════════════════════
async function fetchCoinbase(coins) {
  const results = await Promise.allSettled(coins.map(async coin => {
    const pid = `${coin}-USD`;
    const { status, data } = await httpsGet("api.exchange.coinbase.com", `/products/${pid}/ticker`);
    if (status !== 200) throw new Error(`Coinbase HTTP ${status} for ${pid}`);
    return { coin, price: parseFloat(data.price), bid: parseFloat(data.bid), ask: parseFloat(data.ask), volume: parseFloat(data.volume), time: data.time };
  }));
  return buildPriceResult(coins, results);
}

async function fetchBinance(coins) {
  const results = await Promise.allSettled(coins.map(async coin => {
    const sym = `${coin}USD`;  // Binance.US format: BTCUSD, ETHUSD, SOLUSD
    const [{ status: s1, data: bk }, { status: s2, data: d24 }] = await Promise.all([
      httpsGet("api.binance.us", `/api/v3/ticker/bookTicker?symbol=${sym}`),
      httpsGet("api.binance.us", `/api/v3/ticker/24hr?symbol=${sym}`),
    ]);
    if (s1 !== 200) throw new Error(`Binance bookTicker HTTP ${s1} for ${sym}: ${JSON.stringify(bk).slice(0,100)}`);
    return { coin, price: parseFloat(bk.askPrice), bid: parseFloat(bk.bidPrice), ask: parseFloat(bk.askPrice), volume: parseFloat(d24.volume || 0), time: new Date().toISOString() };
  }));
  return buildPriceResult(coins, results);
}

async function fetchKraken(coins) {
  const pairMap = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
  const results = await Promise.allSettled(coins.map(async coin => {
    const pair = pairMap[coin] || `${coin}USD`;
    const { status, data } = await httpsGet("api.kraken.com", `/0/public/Ticker?pair=${pair}`);
    if (status !== 200 || data.error?.length) throw new Error(`Kraken: ${data.error?.[0] || status}`);
    const v = Object.values(data.result || {})[0];
    return { coin, price: parseFloat(v.c[0]), bid: parseFloat(v.b[0]), ask: parseFloat(v.a[0]), volume: parseFloat(v.v[1]), time: new Date().toISOString() };
  }));
  return buildPriceResult(coins, results);
}

async function fetchGemini(coins) {
  const results = await Promise.allSettled(coins.map(async coin => {
    const { status, data } = await httpsGet("api.gemini.com", `/v1/pubticker/${coin.toLowerCase()}usd`);
    if (status !== 200) throw new Error(`Gemini HTTP ${status} for ${coin}`);
    return { coin, price: parseFloat(data.last), bid: parseFloat(data.bid), ask: parseFloat(data.ask), volume: parseFloat(data.volume?.[coin] || 0), time: new Date().toISOString() };
  }));
  return buildPriceResult(coins, results);
}

async function fetchAlpaca(coins, apiKey, secretKey) {
  if (!apiKey || !secretKey) throw new Error("Alpaca requires API key and secret — pass via proxy credentials");
  const symbols = encodeURIComponent(coins.map(c => `${c}/USD`).join(","));
  const { status, data } = await httpsGet("data.alpaca.markets", `/v1beta3/crypto/us/latest/quotes?symbols=${symbols}`,
    { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secretKey });
  if (status !== 200) throw new Error(`Alpaca HTTP ${status}`);
  const out = {};
  for (const [sym, q] of Object.entries(data.quotes || {})) {
    const coin = sym.replace("/USD", "");
    out[coin] = { coin, price: (q.ap + q.bp) / 2, bid: q.bp, ask: q.ap, volume: 0, time: q.t };
  }
  return out;
}

function buildPriceResult(coins, results) {
  const out = {};
  results.forEach((r, i) => {
    out[coins[i]] = r.status === "fulfilled" ? r.value : { error: r.reason?.message || "failed" };
  });
  return out;
}

function normalisePrice(raw) {
  const data = {}, errors = {};
  for (const [coin, v] of Object.entries(raw)) {
    if (v.error) errors[coin] = v.error;
    else data[coin] = { price: v.price ?? null, bid: v.bid ?? null, ask: v.ask ?? null, volume: v.volume ?? null, time: v.time ?? new Date().toISOString() };
  }
  return { data, ...(Object.keys(errors).length && { errors }) };
}

async function fetchPriceByExchange(exchange, coins, apiKey, secretKey) {
  switch (exchange) {
    case "binance": return fetchBinance(coins);
    case "kraken":  return fetchKraken(coins);
    case "gemini":  return fetchGemini(coins);
    case "alpaca":  return fetchAlpaca(coins, apiKey, secretKey);
    case "public":  return fetchCoinbase(coins); // fallback
    default:        return fetchCoinbase(coins);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ORDER PLACEMENT  (private endpoints — auth required)
// POST /order { exchange, side, coin, quoteSize, baseSize, apiKey, secretKey, ... }
// ═════════════════════════════════════════════════════════════════════════════

function genId() { return `algo-${Date.now()}-${Math.random().toString(36).slice(2,7)}`; }

async function placeBinanceOrder(keys, coin, side, quoteSize, baseSize) {
  const sym = `${coin}USD`;  // Binance.US format: BTCUSD, ETHUSD, SOLUSD
  const ts  = Date.now();
  const sellQty = parseFloat(baseSize.toFixed(8));
  const qty = side === "BUY"
    ? `quoteOrderQty=${quoteSize.toFixed(2)}`
    : `quantity=${sellQty}`;
  const qs  = `symbol=${sym}&side=${side}&type=MARKET&${qty}&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us",
    `/api/v3/order?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance order HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  return { orderId: String(data.orderId), raw: data };
}

async function placeKrakenOrder(keys, coin, side, quoteSize, baseSize) {
  const pairMap = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
  const pair   = pairMap[coin] || `${coin}USD`;
  const volume = side === "BUY"
    ? (quoteSize / 1).toFixed(8)
    : baseSize.toFixed(8);
  const nonce    = String(Date.now());
  const path     = "/0/private/AddOrder";
  const postData = `nonce=${nonce}&ordertype=market&type=${side.toLowerCase()}&volume=${volume}&pair=${pair}`;
  const secret   = Buffer.from(keys.privateKey, "base64");
  const hash     = crypto.createHash("sha256").update(nonce + postData).digest();
  const msg      = Buffer.concat([Buffer.from(path), hash]);
  const sig      = crypto.createHmac("sha512", secret).update(msg).digest("base64");
  const { status, data } = await httpsPost("api.kraken.com", path,
    { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
    postData);
  if (status !== 200 || data.error?.length) throw new Error(`Kraken order: ${data.error?.[0] || `HTTP ${status}`}`);
  return { orderId: data.result?.txid?.[0] || genId(), raw: data };
}

async function placeGeminiOrder(keys, coin, side, quoteSize, baseSize) {
  const sym      = `${coin}usd`;
  const nonce    = String(Date.now());
  const endpoint = "/v1/order/new";
  const amount   = side === "BUY" ? quoteSize.toFixed(8) : baseSize.toFixed(8);
  const bodyObj  = { request: endpoint, nonce, symbol: sym, amount, price: "99999999",
    side: side.toLowerCase(), type: "exchange market", options: ["immediate-or-cancel"] };
  const payload  = Buffer.from(JSON.stringify(bodyObj)).toString("base64");
  const sig      = crypto.createHmac("sha384", keys.secretKey).update(payload).digest("hex");
  const { status, data } = await httpsPost("api.gemini.com", endpoint,
    { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig, "Content-Type": "text/plain" }, "");
  if (status !== 200 || data.result === "error") throw new Error(`Gemini order: ${data.reason || `HTTP ${status}`}`);
  return { orderId: String(data.order_id || genId()), raw: data };
}

async function placeAlpacaOrder(keys, coin, side, quoteSize, baseSize) {
  const sym  = `${coin}/USD`;
  const body = { symbol: sym, side: side.toLowerCase(), type: "market", time_in_force: "ioc",
    ...(side === "BUY" ? { notional: quoteSize.toFixed(2) } : { qty: baseSize.toFixed(8) }) };
  const { status, data } = await httpsPost("api.alpaca.markets", "/v2/orders",
    { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey, "Content-Type": "application/json" },
    JSON.stringify(body));
  if (status !== 200 && status !== 201) throw new Error(`Alpaca order HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  return { orderId: data.id || genId(), raw: data };
}

// ── Order status ─────────────────────────────────────────────────────────────
// GET /orderstatus?exchange=binance&orderId=xxx  + auth headers
async function fetchOrderStatus(exchange, keys, orderId, productId) {
  switch (exchange) {
    case "binance": {
      const ts  = Date.now();
      const qs  = `orderId=${orderId}&symbol=${productId}&timestamp=${ts}`;
      const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
      const { status, data } = await httpsGet("api.binance.us",
        `/api/v3/order?${qs}&signature=${sig}`, { "X-MBX-APIKEY": keys.apiKey });
      if (status !== 200) throw new Error(`Binance order status HTTP ${status}`);
      // For market orders, data.price = "0" — use avg fill price from cummulativeQuoteQty
      const execQty   = parseFloat(data.executedQty || 0);
      const quoteSpent = parseFloat(data.cummulativeQuoteQty || 0);
      const fixedPrice = parseFloat(data.price || 0);
      // Average fill price: total USD spent / total coin qty
      const avgFillPrice = execQty > 0 && quoteSpent > 0
        ? quoteSpent / execQty
        : fixedPrice > 0 ? fixedPrice : 0;
      console.log(`[orderstatus] Binance ${data.orderId}: status=${data.status} execQty=${execQty} quoteSpent=${quoteSpent} price=${fixedPrice} avgFill=${avgFillPrice}`);
      return {
        orderId: String(data.orderId),
        status:  data.status,
        filled:  execQty,
        total:   parseFloat(data.origQty || 0),
        price:   avgFillPrice,
        side:    data.side,
        done:    ["FILLED","CANCELED","REJECTED","EXPIRED"].includes(data.status),
        raw:     { executedQty: data.executedQty, cummulativeQuoteQty: data.cummulativeQuoteQty, price: data.price },
      };
    }
    case "alpaca": {
      const { status, data } = await httpsGet("api.alpaca.markets",
        `/v2/orders/${orderId}`,
        { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey });
      if (status !== 200) throw new Error(`Alpaca order status HTTP ${status}`);
      return {
        orderId: data.id, status: data.status,
        filled: parseFloat(data.filled_qty || 0), total: parseFloat(data.qty || 0),
        price:  parseFloat(data.filled_avg_price || 0), side: data.side?.toUpperCase(),
        done:   ["filled","canceled","expired","replaced"].includes(data.status),
      };
    }
    case "gemini": {
      const nonce = String(Date.now());
      const endpoint = `/v1/order/status`;
      const payloadObj = { request: endpoint, nonce, order_id: parseInt(orderId) };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      const sig = crypto.createHmac("sha384", keys.secretKey).update(payload).digest("hex");
      const { status, data } = await httpsPost("api.gemini.com", endpoint,
        { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig, "Content-Type": "text/plain" }, "");
      if (status !== 200) throw new Error(`Gemini order status HTTP ${status}`);
      return {
        orderId: String(data.order_id), status: data.is_live ? "OPEN" : data.is_cancelled ? "CANCELED" : "FILLED",
        filled: parseFloat(data.executed_amount || 0), total: parseFloat(data.original_amount || 0),
        price: parseFloat(data.avg_execution_price || 0), side: data.side?.toUpperCase(),
        done: !data.is_live,
      };
    }
    default:
      return { orderId, status: "UNKNOWN", done: true }; // Kraken/Coinbase: assume filled
  }
}

// ── Cancel order ─────────────────────────────────────────────────────────────
async function cancelOrderByExchange(exchange, keys, orderId, productId) {
  switch (exchange) {
    case "binance": {
      const ts  = Date.now();
      const qs  = `symbol=${productId}&orderId=${orderId}&timestamp=${ts}`;  // productId should be BTCUSD format
      const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
      const { status, data } = await httpsRequest("DELETE", "api.binance.us",
        `/api/v3/order?${qs}&signature=${sig}`, { "X-MBX-APIKEY": keys.apiKey });
      if (status !== 200) throw new Error(`Binance cancel HTTP ${status}: ${JSON.stringify(data).slice(0,100)}`);
      return { status: data.status, orderId: String(data.orderId) };
    }
    case "alpaca": {
      const { status, data } = await httpsRequest("DELETE", "api.alpaca.markets",
        `/v2/orders/${orderId}`,
        { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey });
      if (status !== 204 && status !== 200) throw new Error(`Alpaca cancel HTTP ${status}`);
      return { status: "CANCELED", orderId };
    }
    case "gemini": {
      const nonce = String(Date.now());
      const endpoint = "/v1/order/cancel";
      const payloadObj = { request: endpoint, nonce, order_id: parseInt(orderId) };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      const sig = crypto.createHmac("sha384", keys.secretKey).update(payload).digest("hex");
      const { status, data } = await httpsPost("api.gemini.com", endpoint,
        { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig, "Content-Type": "text/plain" }, "");
      if (status !== 200) throw new Error(`Gemini cancel HTTP ${status}`);
      return { status: data.is_cancelled ? "CANCELED" : "PENDING", orderId };
    }
    case "kraken": {
      const nonce = String(Date.now());
      const path  = "/0/private/CancelOrder";
      const postData = `nonce=${nonce}&txid=${orderId}`;
      const secret = Buffer.from(keys.privateKey, "base64");
      const hash   = crypto.createHash("sha256").update(nonce + postData).digest();
      const msg    = Buffer.concat([Buffer.from(path), hash]);
      const sig    = crypto.createHmac("sha512", secret).update(msg).digest("base64");
      const { status, data } = await httpsPost("api.kraken.com", path,
        { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" }, postData);
      if (status !== 200 || data.error?.length) throw new Error(`Kraken cancel: ${data.error?.[0] || status}`);
      return { status: "CANCELED", orderId };
    }
    default:
      return { status: "UNKNOWN", orderId, note: `Cancel not supported for ${exchange}` };
  }
}

// ─── Advanced sell order builders ────────────────────────────────────────────
async function placeBinanceLimitSell(keys, sym, qty, limitPrice) {
  const ts  = Date.now();
  const qs  = `symbol=${sym}&side=SELL&type=LIMIT&timeInForce=GTC&quantity=${qty}&price=${limitPrice.toFixed(2)}&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us", `/api/v3/order?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance limit sell HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  return { orderId: String(data.orderId), type: "LIMIT", raw: data };
}

async function placeBinanceStopLimitSell(keys, sym, qty, stopPrice, limitPrice) {
  const ts  = Date.now();
  const qs  = `symbol=${sym}&side=SELL&type=STOP_LOSS_LIMIT&timeInForce=GTC&quantity=${qty}&price=${limitPrice.toFixed(2)}&stopPrice=${stopPrice.toFixed(2)}&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us", `/api/v3/order?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance stop-limit sell HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  return { orderId: String(data.orderId), type: "STOP_LOSS_LIMIT", raw: data };
}

async function placeBinanceOCOSell(keys, sym, qty, tpPrice, stopPrice, limitPrice) {
  const ts  = Date.now();
  const qs  = `symbol=${sym}&side=SELL&quantity=${qty}&price=${tpPrice.toFixed(2)}&stopPrice=${stopPrice.toFixed(2)}&stopLimitPrice=${limitPrice.toFixed(2)}&stopLimitTimeInForce=GTC&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us", `/api/v3/orderList/oco?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance OCO HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  const orderId = data.orderListId ? String(data.orderListId) : String(data.orders?.[0]?.orderId || "oco");
  return { orderId, type: "OCO", raw: data };
}

async function placeBinanceTrailingStopSell(keys, sym, qty, callbackRate) {
  // callbackRate = trailing delta % (Binance requires 0.1–20%)
  const rate = Math.min(Math.max(parseFloat(callbackRate) || 1.5, 0.1), 20).toFixed(2);
  const ts   = Date.now();
  const qs   = `symbol=${sym}&side=SELL&type=TRAILING_STOP_MARKET&quantity=${qty}&callbackRate=${rate}&timestamp=${ts}`;
  const sig  = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us", `/api/v3/order?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance trailing stop HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  return { orderId: String(data.orderId), type: "TRAILING_STOP_MARKET", callbackRate: rate, raw: data };
}

// ─── Limit BUY order ─────────────────────────────────────────────────────────
async function placeBinanceLimitBuy(keys, sym, quoteSize, limitPrice) {
  // For limit BUY on Binance: must specify quantity (baseSize), not quoteSize
  // Calculate qty from quote amount and limit price, then round to lot size
  const rawQty = quoteSize / limitPrice;
  // Binance lot sizes: BTC=0.00001, ETH=0.0001, SOL=0.01
  const coin     = sym.replace(/USD$/, "");
  const lotSteps = { BTC: 0.00001, ETH: 0.0001, SOL: 0.01 };
  const step     = lotSteps[coin] || 0.00001;
  const qty      = Math.floor(rawQty / step) * step;
  const qtyStr   = qty.toFixed(8);
  const priceStr = limitPrice.toFixed(2);
  const ts       = Date.now();
  const qs       = `symbol=${sym}&side=BUY&type=LIMIT&timeInForce=GTC&quantity=${qtyStr}&price=${priceStr}&timestamp=${ts}`;
  const sig      = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsRequest("POST", "api.binance.us", `/api/v3/order?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey, "Content-Length": "0" });
  if (status !== 200) throw new Error(`Binance limit buy HTTP ${status}: ${JSON.stringify(data).slice(0,120)}`);
  console.log(`[limitbuy] ${sym} qty=${qtyStr} price=${priceStr} orderId=${data.orderId}`);
  return { orderId: String(data.orderId), type: "LIMIT_BUY", qty: parseFloat(qtyStr), limitPrice: parseFloat(priceStr), raw: data };
}

// ─── /advancedbuy endpoint ────────────────────────────────────────────────────
// Handles limit BUY orders — market BUY goes through standard /order endpoint
async function placeAdvancedBuy(exchange, keys, coin, quoteSize, currentPrice, buyConfig) {
  const type = buyConfig?.type || "market";
  if (type !== "limit") return null; // caller should use /order for market

  if (exchange === "binance") {
    const off        = parseFloat(buyConfig.limitOffsetValue) || 0.05;
    const limitPrice = buyConfig.limitOffsetType === "absolute"
      ? currentPrice + off
      : currentPrice * (1 + off / 100);
    const sym = `${coin}USD`;
    return placeBinanceLimitBuy(keys, sym, quoteSize, limitPrice);
  }
  return null; // other exchanges fall back to market
}

// Generic advanced sell router — falls back to market for unsupported exchanges
async function placeAdvancedSell(exchange, keys, coin, qty, currentPrice, sellConfig, body = {}) {
  const sym = `${coin}USD`;
  const type = sellConfig?.type || "market";
  console.log(`[advancedSell] ${exchange} ${sym} qty=${qty} type=${type} price=${currentPrice}`);

  if (exchange === "binance") {
    switch (type) {
      case "limit": {
        // _limitPriceOverride: caller pre-computed the exact limit price (post-buy scenario)
        const limit = body._limitPriceOverride
          ? parseFloat(body._limitPriceOverride)
          : (() => {
              const off = parseFloat(sellConfig.limitOffsetValue) || 0;
              return sellConfig.limitOffsetType === "absolute"
                ? currentPrice - off
                : currentPrice * (1 - off / 100);
            })();
        console.log(`[limit sell] ${sym} qty=${qty} limitPrice=${limit.toFixed(2)} override=${!!body._limitPriceOverride}`);
        return placeBinanceLimitSell(keys, sym, qty, limit);
      }
      case "stop_limit": {
        const stopPx  = currentPrice * (1 - (parseFloat(sellConfig.stopPricePct)  || 0.5) / 100);
        const limitPx = currentPrice * (1 - (parseFloat(sellConfig.limitPricePct) || 0.6) / 100);
        return placeBinanceStopLimitSell(keys, sym, qty, stopPx, limitPx);
      }
      case "oco": {
        const tpPx   = currentPrice * (1 + (parseFloat(sellConfig.ocoTpPct) || 2) / 100);
        const slStop = currentPrice * (1 - (parseFloat(sellConfig.ocoSlPct) || 1) / 100);
        const slLim  = slStop * 0.999; // limit slightly below stop
        return placeBinanceOCOSell(keys, sym, qty, tpPx, slStop, slLim);
      }
      case "trailing_stop": {
        // Exchange-native trailing stop — only works for Binance futures/spot
        if (sellConfig.trailDeltaType === "absolute") {
          // Convert absolute $ to % for Binance
          const pct = ((parseFloat(sellConfig.trailStopDelta) || 100) / currentPrice * 100).toFixed(2);
          return placeBinanceTrailingStopSell(keys, sym, qty, pct);
        }
        return placeBinanceTrailingStopSell(keys, sym, qty, sellConfig.trailStopDelta);
      }
      default:
        return null; // falls through to market
    }
  }

  // Other exchanges — only market and limit supported natively
  // For stop_limit / oco / trailing_stop: algo manages exit, place market when triggered
  return null; // signal to caller to use standard market sell
}

async function placeOrderByExchange(exchange, keys, coin, side, quoteSize, baseSize) {
  console.log(`[order] ${exchange} ${side} ${coin} quoteSize=${quoteSize} baseSize=${baseSize}`);
  switch (exchange) {
    case "binance": return placeBinanceOrder(keys, coin, side, quoteSize, baseSize);
    case "kraken":  return placeKrakenOrder(keys, coin, side, quoteSize, baseSize);
    case "gemini":  return placeGeminiOrder(keys, coin, side, quoteSize, baseSize);
    case "alpaca":  return placeAlpacaOrder(keys, coin, side, quoteSize, baseSize);
    case "coinbase": throw new Error("Coinbase orders require CDP JWT signing — not supported via proxy yet");
    case "public":   return { orderId: `pub-sandbox-${genId()}`, raw: { note: "Public.com sandbox" } };
    default: throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BALANCE FETCHERS  (private endpoints — auth required)
// ═════════════════════════════════════════════════════════════════════════════
async function fetchBinanceBalance(keys) {
  const ts  = Date.now();
  const qs  = `timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
  const { status, data } = await httpsGet("api.binance.us", `/api/v3/account?${qs}&signature=${sig}`,
    { "X-MBX-APIKEY": keys.apiKey });
  if (status !== 200) throw new Error(`Binance HTTP ${status}: ${JSON.stringify(data).slice(0, 120)}`);
  const balances = { USD: 0 };
  for (const b of data.balances || []) {
    const v = parseFloat(b.free) + parseFloat(b.locked || 0);
    if (v <= 0) continue;
    if (["USD","BUSD","USDC"].includes(b.asset)) balances.USD = (balances.USD || 0) + v;
    else if (["BTC","ETH","SOL"].includes(b.asset))     balances[b.asset] = v;
  }
  return balances;
}

async function fetchKrakenBalance(keys) {
  const nonce    = String(Date.now());
  const path     = "/0/private/Balance";
  const postData = `nonce=${nonce}`;
  const secret   = Buffer.from(keys.privateKey, "base64");
  const hash     = crypto.createHash("sha256").update(nonce + postData).digest();
  const msg      = Buffer.concat([Buffer.from(path), hash]);
  const sig      = crypto.createHmac("sha512", secret).update(msg).digest("base64");
  const { status, data } = await httpsPost("api.kraken.com", path,
    { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
    postData);
  if (status !== 200 || data.error?.length) throw new Error(`Kraken: ${data.error?.[0] || `HTTP ${status}`}`);
  const r = data.result || {};
  return { USD: parseFloat(r.ZUSD || 0), BTC: parseFloat(r.XXBT || 0), ETH: parseFloat(r.XETH || 0), SOL: parseFloat(r.SOL || 0) };
}

async function fetchGeminiBalance(keys) {
  const nonce      = String(Date.now());
  const endpoint   = "/v1/balances";
  const payloadObj = { request: endpoint, nonce };
  const payload    = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
  const sig        = crypto.createHmac("sha384", keys.secretKey).update(payload).digest("hex");
  const { status, data } = await httpsPost("api.gemini.com", endpoint,
    { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig, "Content-Type": "text/plain" },
    "");
  if (status !== 200) throw new Error(`Gemini HTTP ${status}: ${JSON.stringify(data).slice(0, 120)}`);
  const balances = { USD: 0 };
  for (const b of Array.isArray(data) ? data : []) {
    const v = parseFloat(b.available);
    if (b.currency === "USD")                          balances.USD = v;
    else if (["BTC","ETH","SOL"].includes(b.currency)) balances[b.currency] = v;
  }
  return balances;
}

async function fetchAlpacaBalance(keys) {
  const headers = { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey };
  const [{ status: s1, data: acct }, { status: s2, data: positions }] = await Promise.all([
    httpsGet("api.alpaca.markets", "/v2/account",   headers),
    httpsGet("api.alpaca.markets", "/v2/positions", headers),
  ]);
  if (s1 !== 200) throw new Error(`Alpaca account HTTP ${s1}: ${JSON.stringify(acct).slice(0, 120)}`);
  const balances = { USD: parseFloat(acct.cash || 0) };
  for (const p of Array.isArray(positions) ? positions : []) {
    const coin = p.symbol.replace(/\/USD$/, "").replace(/USD$/, "");
    if (["BTC","ETH","SOL"].includes(coin)) balances[coin] = parseFloat(p.qty);
  }
  return balances;
}

// ═════════════════════════════════════════════════════════════════════════════
// POSITIONS/ORDERS — fetch open positions and recent fills from exchange
// POST /positions { exchange, coins[], apiKey, secretKey, ... }
// Returns: { positions: { BTC: { qty, entryPrice, side, unrealizedPnl } }, fills: [...] }
// ═════════════════════════════════════════════════════════════════════════════
async function fetchPositionsByExchange(exchange, keys, coins) {
  switch (exchange) {

    case "binance": {
      // Binance: open orders + account positions for each coin
      const ts  = Date.now();
      const qs  = `timestamp=${ts}`;
      const sig = crypto.createHmac("sha256", keys.secretKey).update(qs).digest("hex");
      const { status, data } = await httpsGet("api.binance.us",
        `/api/v3/account?${qs}&signature=${sig}`, { "X-MBX-APIKEY": keys.apiKey });
      if (status !== 200) throw new Error(`Binance positions HTTP ${status}`);
      const positions = {};
      for (const b of data.balances || []) {
        const qty = parseFloat(b.free) + parseFloat(b.locked || 0);
        if (qty > 0 && coins.includes(b.asset)) {
          positions[b.asset] = { qty, entryPrice: null, side: "LONG", source: "balance" };
        }
      }
      // Recent fills
      const fills = [];
      for (const coin of coins) {
        const sym = `${coin}USD`;  // Binance.US format
        const fqs = `symbol=${sym}&limit=5&timestamp=${ts}`;
        const fsig = crypto.createHmac("sha256", keys.secretKey).update(fqs).digest("hex");
        const { data: fd } = await httpsGet("api.binance.us",
          `/api/v3/myTrades?${fqs}&signature=${fsig}`, { "X-MBX-APIKEY": keys.apiKey });
        if (Array.isArray(fd)) {
          fd.slice(0, 5).forEach(f => fills.push({
            coin, side: f.isBuyer ? "BUY" : "SELL",
            price: parseFloat(f.price), qty: parseFloat(f.qty),
            time: new Date(f.time).toISOString(), orderId: String(f.orderId),
          }));
        }
      }
      return { positions, fills: fills.sort((a,b) => b.time.localeCompare(a.time)).slice(0, 10) };
    }

    case "kraken": {
      const nonce    = String(Date.now());
      const path     = "/0/private/OpenPositions";
      const postData = `nonce=${nonce}`;
      const secret   = Buffer.from(keys.privateKey, "base64");
      const hash     = crypto.createHash("sha256").update(nonce + postData).digest();
      const msg      = Buffer.concat([Buffer.from(path), hash]);
      const sig      = crypto.createHmac("sha512", secret).update(msg).digest("base64");
      const { status, data } = await httpsPost("api.kraken.com", path,
        { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" }, postData);
      if (status !== 200 || data.error?.length) throw new Error(`Kraken positions: ${data.error?.[0] || status}`);
      const positions = {};
      for (const [, pos] of Object.entries(data.result || {})) {
        const coin = pos.pair.replace(/^X?(XBT|ETH|SOL).*$/,"BTC").replace("XBT","BTC");
        positions[coin] = { qty: parseFloat(pos.vol), entryPrice: parseFloat(pos.cost)/parseFloat(pos.vol), side: pos.type.toUpperCase(), unrealizedPnl: parseFloat(pos.net || 0) };
      }
      return { positions, fills: [] };
    }

    case "gemini": {
      const nonce      = String(Date.now());
      const endpoint   = "/v1/mytrades";
      const payloadObj = { request: endpoint, nonce, limit_trades: 10 };
      const payload    = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      const sig        = crypto.createHmac("sha384", keys.secretKey).update(payload).digest("hex");
      const { status, data } = await httpsPost("api.gemini.com", endpoint,
        { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig, "Content-Type": "text/plain" }, "");
      if (status !== 200) throw new Error(`Gemini trades HTTP ${status}`);
      const fills = (Array.isArray(data) ? data : []).slice(0, 10).map(f => ({
        coin: f.symbol.replace(/usd$/i,"").toUpperCase(),
        side: f.type === "Buy" ? "BUY" : "SELL",
        price: parseFloat(f.price), qty: parseFloat(f.amount),
        time: new Date(f.timestampms).toISOString(), orderId: String(f.order_id),
      }));
      return { positions: {}, fills };
    }

    case "alpaca": {
      const headers = { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey };
      const [{ data: pos }, { data: orders }] = await Promise.all([
        httpsGet("api.alpaca.markets", "/v2/positions", headers),
        httpsGet("api.alpaca.markets", "/v2/orders?status=closed&limit=10", headers),
      ]);
      const positions = {};
      for (const p of Array.isArray(pos) ? pos : []) {
        const coin = p.symbol.replace(/\/USD$/,"").replace(/USD$/,"");
        if (coins.includes(coin)) {
          positions[coin] = { qty: parseFloat(p.qty), entryPrice: parseFloat(p.avg_entry_price), side: p.side.toUpperCase(), unrealizedPnl: parseFloat(p.unrealized_pl) };
        }
      }
      const fills = (Array.isArray(orders) ? orders : []).slice(0,10).map(o => ({
        coin: o.symbol.replace(/\/USD$/,"").replace(/USD$/,""),
        side: o.side.toUpperCase(), price: parseFloat(o.filled_avg_price||0),
        qty: parseFloat(o.filled_qty||0), time: o.filled_at||o.updated_at, orderId: o.id,
      }));
      return { positions, fills };
    }

    default:
      return { positions: {}, fills: [], note: `${exchange} position sync not supported` };
  }
}

async function fetchBalanceByExchange(exchange, keys) {
  switch (exchange) {
    case "binance": return fetchBinanceBalance(keys);
    case "kraken":  return fetchKrakenBalance(keys);
    case "gemini":  return fetchGeminiBalance(keys);
    case "alpaca":  return fetchAlpacaBalance(keys);
    case "coinbase": throw new Error("Coinbase balance requires CDP JWT signing — check balances at coinbase.com or use sandbox mode");
    case "public":   return { USD: 0, _note: "Public.com API is invite-only" };
    default: throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NEWS
// ═════════════════════════════════════════════════════════════════════════════
const POSITIVE_WORDS = ["surge","rally","gain","bull","adopt","approve","record","high","growth","rise","breakout","institutional","launch","etf","partnership","upgrade","milestone","positive","recovery","profit"];
const NEGATIVE_WORDS = ["crash","drop","fall","bear","ban","hack","fraud","loss","decline","sell","fear","concern","risk","plunge","exploit","attack","scam","regulation","lawsuit","penalty","fine","restriction","warning"];
function scoreSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let s = 0;
  POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) s++; });
  NEGATIVE_WORDS.forEach(w => { if (lower.includes(w)) s--; });
  return Math.max(-1, Math.min(1, s / Math.max(POSITIVE_WORDS.length, NEGATIVE_WORDS.length) * 4));
}
async function fetchNews() {
  const { status, data } = await httpsGet(NEWSDATA_HOST,
    `/api/1/news?apikey=${NEWSDATA_KEY}&q=bitcoin%20OR%20ethereum%20OR%20crypto&language=en&size=10`);
  if (status !== 200 || data.status !== "success") throw new Error(data.message || `NewsData HTTP ${status}`);
  return (data.results || []).slice(0, 10).map(a => {
    const sentiment = scoreSentiment(`${a.title || ""} ${a.description || ""}`);
    return { title: a.title || "Untitled", description: a.description?.slice(0, 120) || null,
      source: a.source_id || "Unknown", url: a.link || null, publishedAt: a.pubDate || null,
      sentiment, sentimentLabel: sentiment > 0.1 ? "positive" : sentiment < -0.1 ? "negative" : "neutral" };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
//
// Routes:
//   GET  /?product=BTC,ETH,SOL&exchange=binance   → live prices
//   GET  /news                                     → crypto news
//   POST /balance  { exchange, apiKey, secretKey } → account balances
// ═════════════════════════════════════════════════════════════════════════════
exports.ticker = async (req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.set(k, v));
  if (req.method === "OPTIONS") return res.status(204).send("");

  const route = req.path || "/";
  console.log(`[request] method=${req.method} route=${route}`);
/* 
  if (route === "/settings"     && req.method === "GET")  return handleGetSettings(req, res);
if (route === "/settings"     && req.method === "PUT")  return handlePutSettings(req, res);
if (route === "/transactions" && req.method === "POST") return handlePostTransaction(req, res);
if (route === "/transactions" && req.method === "GET")  return handleGetTransactions(req, res);
if (route === "/subscribe"    && req.method === "POST") return handleSubscribe(req, res);
if (route === "/webhook"      && req.method === "POST") return handleStripeWebhook(req, res);
if (route === "/users"        && req.method === "POST") return handleUserCreated(req, res);
 */
  // ── POST /advancedbuy ────────────────────────────────────────────────────
  if (route === "/advancedbuy" || route === "/advancedbuy/") {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST /advancedbuy" });
    let body;
    try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: e.message }); }
    const { exchange, coin, quoteSize, currentPrice, buyConfig, ...keys } = body;
    if (!exchange || !coin || !quoteSize) return res.status(400).json({ error: "Missing exchange, coin or quoteSize" });
    try {
      const result = await placeAdvancedBuy(exchange, keys, coin, parseFloat(quoteSize), parseFloat(currentPrice), buyConfig);
      if (!result) return res.status(200).json({ fallback: true, reason: `${buyConfig?.type} not supported on ${exchange}` });
      return res.status(200).json({ ...result, exchange, coin, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[advancedbuy] error:", e.message);
      return res.status(502).json({ error: e.message });
    }
  }

  // ── POST /advancedsell ───────────────────────────────────────────────────
  if (route === "/advancedsell") {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST /advancedsell" });
    let body;
    try { body = await readBody(req); } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", detail: e.message });
    }
    const { exchange, coin, qty, currentPrice, sellConfig, ...keys } = body;
    if (!exchange || !coin || !qty) return res.status(400).json({ error: "Missing exchange, coin or qty" });
    console.log(`[advancedsell] ${exchange} ${coin} qty=${qty} type=${sellConfig?.type} price=${currentPrice}`);
    try {
      const result = await placeAdvancedSell(exchange, keys, coin, parseFloat(qty), parseFloat(currentPrice), sellConfig, body);
      if (!result) {
        // Exchange doesn't support this order type natively — caller should use market
        return res.status(200).json({ fallback: true, reason: `${sellConfig?.type} not supported natively on ${exchange}, use market order` });
      }
      return res.status(200).json({ ...result, exchange, coin, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[advancedsell] error:", e.message);
      return res.status(502).json({ error: e.message, exchange, coin });
    }
  }

  // ── POST /order ──────────────────────────────────────────────────────────
  if (route === "/order") {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST /order" });
    }
    let body;
    try { body = await readBody(req); } catch (e) {
      return res.status(400).json({ error: "Invalid JSON body", detail: e.message });
    }
    console.log("[order] body:", JSON.stringify({ ...body, apiKey: "***", secretKey: "***", privateKey: "***" }));
    const { exchange, coin, side, quoteSize, baseSize, ...keys } = body;
    if (!exchange || !coin || !side) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["exchange", "coin", "side", "quoteSize or baseSize"],
        example: { exchange: "binance", coin: "BTC", side: "BUY", quoteSize: 50, apiKey: "...", secretKey: "..." },
      });
    }
    if (!["BUY","SELL"].includes(side.toUpperCase())) {
      return res.status(400).json({ error: `Invalid side: ${side}. Must be BUY or SELL` });
    }
    try {
      const result = await placeOrderByExchange(
        exchange.toLowerCase(), keys,
        coin.toUpperCase(),
        side.toUpperCase(),
        parseFloat(quoteSize) || 0,
        parseFloat(baseSize)  || 0
      );
      console.log("[order] success:", result.orderId);
      return res.status(200).json({ ...result, exchange, coin, side, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[order] error:", e.message);
      return res.status(502).json({ error: e.message, exchange, coin, side });
    }
  }

  // ── POST /positions ──────────────────────────────────────────────────────
  if (route === "/positions") {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST /positions" });
    let body;
    try { body = await readBody(req); } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", detail: e.message });
    }
    const { exchange, coins, ...keys } = body;
    if (!exchange) return res.status(400).json({ error: "Missing exchange field" });
    const coinList = Array.isArray(coins) ? coins : ["BTC", "ETH", "SOL"];
    console.log(`[positions] ${exchange} coins=${coinList.join(",")}`);
    try {
      const result = await fetchPositionsByExchange(exchange, keys, coinList);
      return res.status(200).json({ ...result, exchange, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[positions] error:", e.message);
      return res.status(502).json({ error: e.message, exchange });
    }
  }

  // ── POST /balance ─────────────────────────────────────────────────────────
  if (route === "/balance") {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST /balance with JSON body: { exchange, apiKey, secretKey }" });
    }

    // Deep diagnostics — log everything about the request
    console.log("[balance] ── REQUEST DIAGNOSTICS ──────────────────────");
    console.log("[balance] method:", req.method);
    console.log("[balance] path:", req.path);
    console.log("[balance] headers:", JSON.stringify(req.headers));
    console.log("[balance] req.body type:", typeof req.body);
    console.log("[balance] req.body value:", JSON.stringify(req.body));
    console.log("[balance] req.rawBody type:", typeof req.rawBody);
    console.log("[balance] req.rawBody value:", req.rawBody ? req.rawBody.toString().slice(0, 200) : "undefined");
    console.log("[balance] req.query:", JSON.stringify(req.query));
    console.log("[balance] ─────────────────────────────────────────────");

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return res.status(400).json({
        error: "Could not parse request body as JSON",
        detail: e.message,
        hint: "Set Content-Type: application/json and send valid JSON",
      });
    }
    console.log("[balance] readBody result:", JSON.stringify(body));
    console.log("[balance] exchange:", body.exchange, "| keys present:", Object.keys(body).filter(k => k !== "exchange").join(", "));
    const { exchange, ...keys } = body;
    if (!exchange) {
      return res.status(400).json({
        error: "Missing 'exchange' field in JSON body",
        received: Object.keys(body),
        example: { exchange: "binance", apiKey: "YOUR_KEY", secretKey: "YOUR_SECRET" },
      });
    }
    const validExchanges = ["binance","kraken","gemini","alpaca","coinbase","public"];
    if (!validExchanges.includes(exchange)) {
      return res.status(400).json({ error: `Unknown exchange: ${exchange}`, valid: validExchanges });
    }
    try {
      const balances = await fetchBalanceByExchange(exchange, keys);
      console.log("[balance] success:", exchange, JSON.stringify(balances));
      return res.status(200).json({ balances, exchange, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[balance] error:", exchange, e.message);
      return res.status(502).json({ error: e.message, exchange });
    }
  }

  // ── GET /news ─────────────────────────────────────────────────────────────
  if (route === "/news" && req.method === "GET") {
    try {
      const articles = await fetchNews();
      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      return res.status(200).json({ articles, fetchedAt: new Date().toISOString() });
    } catch (e) {
      return res.status(502).json({ error: "News fetch failed", detail: e.message });
    }
  }

  // ── POST /cancelorder ────────────────────────────────────────────────────
  if (route === "/cancelorder" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", detail: e.message });
    }
    const { exchange, orderId, productId, ...keys } = body;
    if (!exchange || !orderId) return res.status(400).json({ error: "Missing exchange or orderId" });
    console.log(`[cancel] ${exchange} orderId=${orderId}`);
    try {
      const result = await cancelOrderByExchange(exchange, keys, orderId, productId || "");
      return res.status(200).json({ ...result, exchange, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error("[cancel] error:", e.message);
      return res.status(502).json({ error: e.message, exchange, orderId });
    }
  }

  // ── POST /agent ──────────────────────────────────────────────────────────
  // Proxies Anthropic API calls — API key lives on the server, never in browser
  if (route === "/agent" || route === "/agent/") {
    let body;
    try { body = await readBody(req); } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", detail: e.message });
    }
    const { prompt } = body;
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST /agent with JSON body: { prompt }" });
    if (!prompt) return res.status(400).json({ error: "Missing prompt field" });

    // DeepSeek API key — set as Cloud Run env var: DEEPSEEK_API_KEY
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "DEEPSEEK_API_KEY not set on server. Add it as a Cloud Run environment variable." });

    try {
      // DeepSeek uses OpenAI-compatible API format
      const deepseekRes = await new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify({
          model: "deepseek-chat",   // deepseek-chat = DeepSeek-V3 (fastest, cheapest)
          max_tokens: 512,
          temperature: 0.1,         // low temperature for consistent JSON output
          messages: [{ role: "user", content: prompt }],
        });
        const req2 = https.request(
          {
            hostname: "api.deepseek.com",
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
              "Content-Length": Buffer.byteLength(bodyStr),
            },
          },
          (r) => {
            let data = "";
            r.on("data", c => data += c);
            r.on("end", () => {
              try { resolve({ status: r.statusCode, data: JSON.parse(data) }); }
              catch { resolve({ status: r.statusCode, data }); }
            });
          }
        );
        req2.on("error", reject);
        req2.setTimeout(30000, () => req2.destroy(new Error("DeepSeek API timeout")));
        req2.write(bodyStr);
        req2.end();
      });

      if (deepseekRes.status !== 200) {
        return res.status(502).json({
          error: `DeepSeek API returned HTTP ${deepseekRes.status}`,
          detail: typeof deepseekRes.data === "object" ? deepseekRes.data?.error?.message : deepseekRes.data,
        });
      }

      // DeepSeek follows OpenAI response format: choices[0].message.content
      const text = deepseekRes.data?.choices?.[0]?.message?.content || "";
      console.log(`[agent] DeepSeek response length: ${text.length}`);
      return res.status(200).json({ text, fetchedAt: new Date().toISOString() });

    } catch (e) {
      console.error("[agent] error:", e.message);
      return res.status(502).json({ error: e.message });
    }
  }

  // ── GET /orderstatus ─────────────────────────────────────────────────────
  if (route === "/orderstatus" && req.method === "GET") {
    const { exchange, orderId, productId } = req.query;
    const apiKey    = req.query.apiKey    || req.headers["x-api-key"]    || "";
    const secretKey = req.query.secretKey || req.headers["x-secret-key"] || "";
    const privateKey = req.query.privateKey || "";
    if (!exchange || !orderId) return res.status(400).json({ error: "Missing exchange or orderId" });
    try {
      const result = await fetchOrderStatus(exchange, { apiKey, secretKey, privateKey }, orderId, productId || "");
      return res.status(200).json({ ...result, fetchedAt: new Date().toISOString() });
    } catch (e) {
      return res.status(502).json({ error: e.message, exchange, orderId });
    }
  }

  // ── GET / (prices) ────────────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: `Method ${req.method} not allowed for ${route}` });

  const productParam = req.query.product;
  const exchange     = (req.query.exchange || "coinbase").toLowerCase().trim();
  const apiKey       = req.query.apiKey    || req.headers["x-api-key"]    || "";
  const secretKey    = req.query.secretKey || req.headers["x-secret-key"] || "";

  if (!productParam) {
    return res.status(400).json({
      error: "Missing ?product= param",
      routes: {
        prices:  "GET  /?product=BTC,ETH,SOL&exchange=binance",
        news:    "GET  /news",
        balance: "POST /balance  body: { exchange, apiKey, secretKey }",
        order:   "POST /order    body: { exchange, coin, side, quoteSize, apiKey, secretKey }",
      },
    });
  }

  const coins = productParam
    .split(",")
    .map(p => p.trim().toUpperCase().replace(/-?USD[T]?$/, "").replace(/^X?BT$/, "BTC"))
    .filter(c => /^[A-Z]{2,6}$/.test(c))
    .slice(0, 10);

  if (!coins.length) return res.status(400).json({ error: `No valid coin symbols in: ${productParam}` });

  try {
    const raw = await fetchPriceByExchange(exchange, coins, apiKey, secretKey);
    const { data, errors } = normalisePrice(raw);
    res.set("Cache-Control", "public, max-age=5, s-maxage=5");
    return res.status(200).json({ data, ...(errors && Object.keys(errors).length && { errors }), exchange, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: `${exchange} price fetch failed`, detail: e.message });
  }
};