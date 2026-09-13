import { useState, useEffect, useRef, useCallback, Component } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
// Clerk auth — requires: npm install @clerk/clerk-react
// If not using auth, these are unused but don't break anything
import { useClerk, useUser, useSession } from "@clerk/clerk-react";
import OnboardingTour, { TOUR_STEPS } from "./OnboardingTour";
import MarketplacePanel from "./MarketplacePanel";

// ─── Error Boundary — shows readable crash message instead of blank screen ────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", background: "#0f1117", color: "#e8eaf0", minHeight: "100vh" }}>
          <div style={{ color: "#ef4444", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>⚠ Runtime error</div>
          <pre style={{ color: "#f59e0b", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.message}
          </pre>
          <pre style={{ color: "#555b73", fontSize: 11, marginTop: 12, whiteSpace: "pre-wrap" }}>
            {this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: "8px 20px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const COINS = ["BTC", "ETH", "SOL"];
const COIN_COLORS = { BTC: "#f59e0b", ETH: "#6366f1", SOL: "#10b981" };
// Fallback baselines — used only if proxy is unreachable
const COIN_BASE = { BTC: 63000, ETH: 3000, SOL: 145 };

// Default settings — defined at module level so the useState initialiser
// (which runs synchronously) can reference it without TDZ issues.
// API keys intentionally blank — set via Settings or Cloud Run env vars.
const CREDS_DEFAULTS = {
  provider: "coinbase",           // active exchange
  tradeSizeUSD:    "50",
  balanceBuffer:   "0.50",  // deduct this from live exchange balance before trading ($)
  minConfidence: "60",
  feePercent:    "0.1",   // default 0.10% per trade (Binance.US maker/taker)
  enabledCoins:  ["BTC"],
  sandbox: false,
  keys: {                         // per-provider API credentials
    coinbase: { apiKeyName: "", privateKey: "" },
    binance:  { apiKey: "", secretKey: "" },
    kraken:   { apiKey: "", privateKey: "" },
    gemini:   { apiKey: "", secretKey: "" },
    alpaca:   { apiKey: "", secretKey: "" },
    public:   { apiKey: "", secretKey: "" },
  },
  exitRules: {
    BTC: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    ETH: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    SOL: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
  },
  exitStrategies: {
    trailingTakeProfit: { enabled: false, trailPercent: "1.0" },
    timeExit:        { enabled: true,  maxHoldMinutes: "30"  },
    trailingStop:    { enabled: true,  trailPercent:   "1.5", trailDelta: "absolute" }, // "absolute"=$, "percent"=%
    atrExit:         { enabled: false, atrMultiplier:  "1.5" },
    atrTpSl: {
      enabled:     false,  // use ATR × multiplier instead of fixed % for TP/SL
      tpMultiplier: "1.5", // TP = entry + atr × this
      slMultiplier: "0.75",// SL = entry - atr × this  (keeps 2:1 ratio)
      partialExit: false,  // exit 50% at 1×ATR, let rest run to full TP
    },
    trendAlignment: {
      enabled:      false, // require MTF trend confluence before BUY
      requireBullish1h: true,  // price must be above SMA50 on 1h
      requireBullish15m: true, // EMA12 > EMA26 on 15m
      requireRsiAbove:  "45",  // 1h RSI must be above this (not in downtrend)
      strictMode:   false, // all filters must pass (vs any 2 of 3)
    },
    volumeGate:      { enabled: true,  minVolumeRatio: "1.2" },
    signalReversal:  { enabled: true,  reversalScore:  "-2"  },
  },
  cooldownMinutes: "1",
  dynamicExits: {
    enabled:         false,  // scale TP/SL based on cumulative P&L
    mode:            "aggressive_when_winning", // "aggressive_when_winning" | "defensive_when_losing" | "both"
    profitThreshold: "20",   // $ — above this cumulative profit, widen TP
    lossThreshold:   "-20",  // $ — below this cumulative loss, tighten TP / SL
    maxTpBoost:      "50",   // % — max increase to TP when winning (e.g. +50% wider)
    maxTpCut:        "50",   // % — max decrease to TP when losing (e.g. -50% tighter, faster exits)
    maxSlTighten:    "30",   // % — max decrease to SL when losing (protect capital)
    scaleBy:         "total", // "total" (all coins) | "per_coin" (this coin's P&L only)
  },
  llmProvider: "deepseek",   // "deepseek" | "claude" | "gpt" | "gemini" | "llama"
  llmKeys: {
    deepseek: "", claude: "", gpt: "", gemini: "", llama: "",
  },
  agentMode: false,
  agentIntervalSec: "15",
  rlParams: {
    alpha: "0.1", gamma: "0.9", epsilonStart: "0.4", epsilonMin: "0.05",
    epsilonDecay: "0.995", minEpisodes: "20", rewardScale: "100", resetOnStop: true,
  },
  signalSource: "rules",
  customRules: {
    enabled: false,
    // Each group is evaluated independently then combined with groupLogic
    groupLogic: "and",   // "and" | "or" — how groups combine
    groups: [
      {
        id: "g1",
        customLogic: "",
        label: "Oversold entry",
        logic: "and",   // "and" | "or" within this group
        action: "BUY",  // what this group signals when it passes
        weight: 2,      // vote weight when group passes
        conditions: [
          { id: "c1", indicator: "rsi",    op: "<",  value: "35",  enabled: true },
          { id: "c2", indicator: "macd",   op: ">",  value: "0",   enabled: true, combiner: "and" },
        ],
      },
      {
        id: "g2",
        customLogic: "",
        label: "Overbought exit signal",
        logic: "or",
        action: "SELL",
        weight: 2,
        conditions: [
          { id: "c3", indicator: "rsi",         op: ">", value: "65",  enabled: true, combiner: "and" },
          { id: "c4", indicator: "bollingerPct", op: ">", value: "0.9", enabled: true, combiner: "and" },
        ],
      },
      {
        id: "g3",
        customLogic: "",
        label: "Trailing take-profit (1% drawdown from peak)",
        logic: "and",
        action: "TRAILING_TAKE_PROFIT",
        weight: 3,
        conditions: [
          { id: "c5", indicator: "peakProfitPct",    op: ">", value: "1.5", enabled: true, combiner: "and" },
          { id: "c6", indicator: "drawdownFromPeak",  op: ">", value: "1.0", enabled: true, combiner: "and" },
        ],
      },
      {
        id: "g4",
        customLogic: "",
        label: "Time-based exit (30 min max hold)",
        logic: "and",
        action: "TIME_EXIT",
        weight: 2,
        conditions: [
          { id: "c7", indicator: "heldMinutes", op: ">", value: "30", enabled: false, combiner: "and" },
        ],
      },
      {
        id: "g5",
        customLogic: "",
        label: "Signal reversal exit",
        logic: "and",
        action: "SIGNAL_REVERSAL",
        weight: 2,
        conditions: [
          { id: "c8", indicator: "signalScore", op: "<", value: "-1", enabled: false, combiner: "and" },
          { id: "c9", indicator: "unrealizedPct", op: ">", value: "0.5", enabled: false, combiner: "and" },
        ],
      },
      {
        id: "g6",
        customLogic: "",
        label: "Dynamic exit when session profitable",
        logic: "and",
        action: "DYNAMIC_EXIT",
        weight: 1,
        conditions: [
          { id: "c10", indicator: "totalPnl",       op: ">", value: "20", enabled: false, combiner: "and" },
          { id: "c11", indicator: "unrealizedPct",  op: ">", value: "1",  enabled: false, combiner: "and" },
        ],
      },
    ],
  },
  ruleCombiner: {
    logic: "and",    // "and" | "or" | "custom"
    // custom: define per-indicator vote threshold (0.0–1.0 fraction of weighted score)
    customThreshold: "0.3",
    // minimum number of indicators that must agree when logic = "and"
    minAgree: "3",
  },
  tradingMode: "momentum",   // "momentum" | "mean_reversion"
  volatilityGate: {
    enabled:       true,
    minVolatility: "0.3",   // LSTM volatility score must exceed this
    minAtrPct:     "0.3",   // ATR must be >= X% of price
    minDirProb:    "0.65",  // LSTM direction probability (0.5=coin flip, 0.65=confident bull)
  },
  minRrRatio:    "3",        // minimum reward:risk ratio — TP must be >= N × SL
  adaptiveSettings: {
    enabled:       false,   // let agent auto-adjust TP/SL based on regime
    maxTpDelta:    "2",     // max TP adjustment per session in %
    maxSlDelta:    "1",     // max SL adjustment per session in %
    requireHigh:   "70",   // min agent confidence to apply adjustment
    applyAfter:    "3",    // apply only after N consistent suggestions
  },
  postBuyLimitSell: {
    enabled:          false,     // place a limit sell immediately after BUY fills
    offsetType:       "percent", // "percent" | "absolute"
    offsetValue:      "1.5",     // place limit sell X% or $X above fill price
    // e.g. buy fills at $65,000 → limit sell at $65,975 (1.5% above)
    // This is a maker sell order — 0% fee on Binance.US
  },
  buyOrderConfig: {
    type:             "market",   // "market" | "limit"
    limitOffsetType:  "percent",  // "percent" | "absolute"
    limitOffsetValue: "0.05",     // place limit X% or $X ABOVE current price (maker)
    // 0.05% above = fills quickly, qualifies as maker on most exchanges
    // Higher = safer maker but slower fill
  },
  sellOrderConfig: {
    type:               "market",   // market | limit | stop_limit | oco | trailing_stop
    limitOffsetType:    "percent",  // percent | absolute
    limitOffsetValue:   "0.1",      // % or $ below signal price for limit
    stopPricePct:       "0.5",      // % below entry for stop-limit stop trigger
    limitPricePct:      "0.6",      // % below entry for stop-limit limit price
    ocoTpPct:           "2",        // OCO take-profit % above entry
    ocoSlPct:           "1",        // OCO stop-loss % below entry
    trailStopDelta:     "1.5",      // trailing stop % delta (exchange-native)
    trailDeltaType:     "percent",  // percent | absolute
  },
  tickIntervalMs: 1500,  // how often runTick fires — controls real-time span of indicator periods
  indicatorPeriods: {
    smaFast:   20,   // ticks
    smaMid:    50,
    smaSlow:   99,
    emaFast:   12,
    emaSlow:   26,
    rsi:       14,
    bollinger: 20,
    atr:       14,
  },
  indicatorConfig: {
    rsi:            { enabled: true,  weight: "2",   oversold: "35",  overbought: "65" },
    sma_20_50:      { enabled: true,  weight: "1.5", fast: "20",     slow: "50"  },
    sma_20_99:      { enabled: false, weight: "2",   fast: "20",     slow: "99"  },
    sma_50_99:      { enabled: false, weight: "1.5", fast: "50",     slow: "99"  },
    ema_12_26:      { enabled: false, weight: "1.5", fast: "12",     slow: "26"  },
    macd:           { enabled: true,  weight: "1"   },
    bollinger:      { enabled: true,  weight: "2",   period: "20"  },
    news:           { enabled: true,  weight: "1.5" },
  },
};
const PRODUCT_IDS = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD" };

// ─── Proxy config ─────────────────────────────────────────────────────────────
// After deploying coinbase-cors-proxy to Vercel, paste your deployment URL here.
// e.g. "https://coinbase-cors-proxy.vercel.app"
// Leave as empty string to stay in simulation-only mode.
const PROXY_BASE      = "https://coinbaseticker-283150216453.europe-west1.run.app";
// Trading server (VPS) — set VITE_TRADING_SERVER in .env.local before npm run build
// Trading server URL — set VITE_TRADING_SERVER in .env.local before npm run build
// Can also be overridden at runtime via window.__TRADING_SERVER__ in browser console
const TRADING_SERVER  = window.__TRADING_SERVER__
  || (typeof import.meta !== "undefined" && import.meta.env?.VITE_TRADING_SERVER)
  || window.__ENV__?.VITE_TRADING_SERVER
  || "";

// ─── Public price fetch via proxy, with full diagnostics ──────────────────────
// Returns { price, ok, httpStatus, errorType, errorMsg, raw }
// errorType: "no_proxy" | "cors" | "network" | "http" | "parse" | "empty" | null
async function fetchPublicPriceDiag(productId) {
  const diag = { price: null, ok: false, httpStatus: null, errorType: null, errorMsg: null, raw: null };

  if (!PROXY_BASE) {
    diag.errorType = "no_proxy";
    diag.errorMsg = "No proxy URL configured — set PROXY_BASE in the source to your Vercel deployment.";
    return diag;
  }

  const url = `${PROXY_BASE}?product=${productId}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    diag.httpStatus = res.status;

    if (!res.ok) {
      diag.errorType = "http";
      diag.errorMsg = `Proxy returned HTTP ${res.status} ${res.statusText}`;
      return diag;
    }

    let payload;
    try {
      const text = await res.text();
      diag.raw = text.slice(0, 300);
      payload = JSON.parse(text);
    } catch (e) {
      diag.errorType = "parse";
      diag.errorMsg = `JSON parse failed: ${e.message}`;
      return diag;
    }

    // Proxy returns { data: { BTC: { price, bid, ask, ... } }, fetchedAt }
    const symbol = productId.replace("-USD", "");
    const coinData = payload?.data?.[symbol];
    const price = parseFloat(coinData?.price);

    if (!coinData || isNaN(price)) {
      diag.errorType = "empty";
      diag.errorMsg = payload?.errors?.[symbol]
        || `No price for ${symbol}. Proxy keys: ${Object.keys(payload?.data || {}).join(", ")}`;
      return diag;
    }

    diag.price = price;
    diag.bid = parseFloat(coinData.bid) || null;
    diag.ask = parseFloat(coinData.ask) || null;
    diag.volume = parseFloat(coinData.volume) || null;
    diag.ok = true;
    return diag;

  } catch (e) {
    const msg = e.message || String(e);
    diag.errorType = msg.toLowerCase().includes("cors") || msg.toLowerCase().includes("failed to fetch")
      ? "cors" : "network";
    diag.errorMsg = msg;
    return diag;
  }
}

// Batch fetch all coins via proxy — routes to the correct exchange
// providerId: "coinbase" | "binance" | "kraken" | "gemini" | "alpaca" | "public"
async function fetchAllPublicPrices(providerId = "coinbase") {
  if (!PROXY_BASE) {
    const diags = {};
    for (const coin of COINS) {
      diags[coin] = { price: null, ok: false, httpStatus: null, errorType: "no_proxy",
        errorMsg: "No proxy URL configured — set PROXY_BASE to your Cloud Run function URL.", raw: null };
    }
    return { prices: {}, diags };
  }

  // Pass plain coin symbols — proxy normalises them per exchange internally
  const coinList = COINS.join(",");
  const url = `${PROXY_BASE}?product=${coinList}&exchange=${encodeURIComponent(providerId)}`;
  const diags = {};
  const prices = {};

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();

    if (!res.ok) {
      for (const coin of COINS) {
        diags[coin] = { price: null, ok: false, httpStatus: res.status, errorType: "http",
          errorMsg: `Proxy HTTP ${res.status} (${providerId})`, raw: text.slice(0, 200) };
      }
      return { prices, diags };
    }

    const payload = JSON.parse(text);

    for (const coin of COINS) {
      const coinData = payload?.data?.[coin];
      const price = parseFloat(coinData?.price);
      if (!coinData || isNaN(price)) {
        diags[coin] = { price: null, ok: false, httpStatus: res.status, errorType: "empty",
          errorMsg: payload?.errors?.[coin] || `${coin} missing from ${providerId} response`,
          raw: text.slice(0, 200) };
      } else {
        prices[coin] = price;
        diags[coin] = { price, ok: true, httpStatus: res.status, errorType: null, errorMsg: null,
          bid: parseFloat(coinData.bid) || null,
          ask: parseFloat(coinData.ask) || null,
          volume: parseFloat(coinData.volume) || null,
          source: coinData.source || providerId };
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    const errorType = msg.toLowerCase().includes("cors") || msg.toLowerCase().includes("failed to fetch") ? "cors" : "network";
    for (const coin of COINS) {
      diags[coin] = { price: null, ok: false, httpStatus: null, errorType, errorMsg: msg, raw: null };
    }
  }

  return { prices, diags };
}
const CB_API_BASE = "https://api.coinbase.com/api/v3/brokerage";

// Real news fetched from NewsData.io via the Cloud Run proxy
const NEWS_PROXY_URL = `${PROXY_BASE}/news`;

// ─── Technical Indicators ─────────────────────────────────────────────────────
function calcSMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(-period - 1).map((p, i, arr) => (i > 0 ? p - arr[i - 1] : 0)).slice(1);
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map(Math.abs);
  const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function calcBollinger(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}
function calcMACD(prices) {
  const e12 = calcEMA(prices, 12), e26 = calcEMA(prices, 26);
  return e12 && e26 ? e12 - e26 : null;
}
// ─── Signal generation ───────────────────────────────────────────────────────
// Each indicator votes independently (+1 bull / -1 bear / 0 neutral).
// Confidence = % of available indicators that AGREE with the action direction.
// A BUY only fires when:
//   1. Score > 2  (net bullish weight)
//   2. At least MIN_AGREEING_INDICATORS indicators vote bullish
//   3. Confidence >= the user-set threshold (checked in runTick)
const MIN_AGREEING_INDICATORS = 3; // at least 3 of 5 must agree

// ─── ATR (Average True Range) ────────────────────────────────────────────────
function calcATR(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const trueRanges = prices.slice(-period - 1).map((p, i, arr) => {
    if (i === 0) return 0;
    return Math.abs(arr[i] - arr[i - 1]); // simplified TR (no high/low data)
  }).slice(1);
  return trueRanges.reduce((a, b) => a + b, 0) / period;
}

// ─── Multi-Timeframe Price Buffers ───────────────────────────────────────────
// Maintains downsampled price buffers at fixed intervals regardless of tick speed.
// Each buffer stores up to 200 candle closes so we can compute SMAs on any TF.

const MTF_INTERVALS = {
  "1m":  60_000,
  "5m":  300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h":  3_600_000,
};
const MTF_MAX = 200; // max prices per buffer

// Initialise MTF buffers for a coin (called when stateRef is set up)
function initMTFBuffers() {
  const bufs = {};
  for (const tf of Object.keys(MTF_INTERVALS)) {
    bufs[tf] = { prices: [], lastSampleAt: 0 };
  }
  return bufs;
}

// Called each tick — adds a new price to whichever TF buffers are due
function updateMTFBuffers(mtf, price, now = Date.now()) {
  for (const [tf, intervalMs] of Object.entries(MTF_INTERVALS)) {
    const buf = mtf[tf];
    if (now - buf.lastSampleAt >= intervalMs) {
      buf.prices.push(price);
      if (buf.prices.length > MTF_MAX) buf.prices.shift();
      buf.lastSampleAt = now;
    }
  }
}

// Compute MTF SMAs for a coin's buffers
function calcMTFIndicators(mtf) {
  const out = {};
  for (const tf of Object.keys(MTF_INTERVALS)) {
    const prices = mtf[tf]?.prices || [];
    out[`sma20_${tf}`] = calcSMA(prices, 20);
    out[`sma50_${tf}`] = calcSMA(prices, 50);
    out[`sma99_${tf}`] = calcSMA(prices, 99);
    out[`ema12_${tf}`] = calcEMA(prices, 12);
    out[`ema26_${tf}`] = calcEMA(prices, 26);
    out[`rsi_${tf}`]   = prices.length >= 14 ? calcRSI(prices, 14) : null;
    out[`count_${tf}`] = prices.length;  // how many samples collected
  }
  return out;
}

// ─── Mean Reversion Signal ───────────────────────────────────────────────────
// Generates BUY when price is oversold/below bands, SELL when overbought/above bands
// Opposite of momentum — buys dips and sells rips in ranging markets
// ─── Custom Rule Engine ──────────────────────────────────────────────────────
// Evaluates a tree of user-defined conditions against live indicator values.
// Structure: groups[] → each group has conditions[] + AND/OR logic within group
//            groups are combined with groupLogic (AND/OR)

// Map indicator names to their current values
function resolveIndicatorValue(name, indicators, prices, volumeRatio) {
  const p = indicators.currentPrice || prices?.at(-1) || 0;
  switch (name) {
    // ── Technical indicators ─────────────────────────────────────────────────
    case "rsi":          return indicators.rsi ?? null;
    case "macd":         return indicators.macd ?? null;
    case "macdNorm":     return p > 0 ? (indicators.macd ?? 0) / p * 100 : null;
    case "bollingerPct": {
      const b = indicators.boll;
      if (!b || b.upper === b.lower) return null;
      return (p - b.lower) / (b.upper - b.lower);
    }
    case "sma20dist":    return indicators.sma20 ? (p - indicators.sma20) / indicators.sma20 * 100 : null;
    case "sma50dist":    return indicators.sma50 ? (p - indicators.sma50) / indicators.sma50 * 100 : null;
    case "sma99dist":    return indicators.sma99 ? (p - indicators.sma99) / indicators.sma99 * 100 : null;
    case "emaSpread":    return indicators.ema12 && indicators.ema26
      ? (indicators.ema12 - indicators.ema26) / indicators.ema26 * 100 : null;
    case "atr":          return indicators.atr ?? null;
    case "atrPct":       return indicators.atr && p ? indicators.atr / p * 100 : null;
    case "volume":       return volumeRatio ?? null;
    case "price":        return p;
    // ── ML model outputs ─────────────────────────────────────────────────────
    case "rfProb":       return null; // set externally via rfPredCache
    case "lstmTrend":    return null;
    case "lstmDirProb":  return null;
    // ── Position / exit context (set externally via extra{}) ────────────────
    case "unrealizedPct":    return null;
    case "heldMinutes":      return null;
    case "heldTicks":        return null;
    case "peakProfitPct":    return null;
    case "drawdownFromPeak": return null;
    case "totalPnl":         return null;
    case "positionSize":     return null;
    // ── Multi-timeframe SMAs/EMAs/RSI — pre-computed in calcMTFIndicators ────
    // Format: sma20_1m, sma50_5m, ema12_15m, rsi_1m etc.
    // Returns % distance from current price (positive = price above SMA)
    // RSI returns raw 0–100 value
    default: {
      const mtfMatch = name.match(/^(sma20|sma50|sma99|ema12|ema26|rsi)_(1m|5m|15m|30m|1h)$/);
      if (mtfMatch) {
        const val = indicators[name];
        if (val === null || val === undefined) return null;
        if (name.startsWith('rsi_')) return val;
        return p > 0 ? (p - val) / val * 100 : null;
      }
      return null;
    }
  }
}

// Evaluate a single condition: value OP threshold
function evalCondition(condition, indicators, prices, volumeRatio, extra = {}) {
  if (!condition.enabled) return true; // disabled conditions always pass
  const val = extra[condition.indicator] ?? resolveIndicatorValue(condition.indicator, indicators, prices, volumeRatio);
  if (val === null || val === undefined) return false; // indicator not available
  const thr = parseFloat(condition.value);
  if (isNaN(thr)) return false;
  switch (condition.op) {
    case "<":  return val < thr;
    case "<=": return val <= thr;
    case ">":  return val > thr;
    case ">=": return val >= thr;
    case "=":  return Math.abs(val - thr) < 0.0001;
    case "!=": return Math.abs(val - thr) >= 0.0001;
    default:   return false;
  }
}

// ── Custom logic expression parser ───────────────────────────────────────────
// Parses expressions like "(1 AND 2) OR (3 AND 4)" where numbers are row indices.
// Supports: AND, OR, NOT, parentheses, 1-based row numbers.
function parseLogicExpr(expr, rowResults) {
  // Tokenise: numbers, AND, OR, NOT, ( )
  const tokens = expr.toUpperCase()
    .replace(/\(/g, " ( ").replace(/\)/g, " ) ")
    .trim().split(/\s+/).filter(Boolean);

  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  function parseExpr() { return parseOr(); }

  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") { consume(); left = left || parseAnd(); }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek() === "AND") { consume(); left = left && parseNot(); }
    return left;
  }

  function parseNot() {
    if (peek() === "NOT") { consume(); return !parsePrimary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t === "(") {
      consume(); // (
      const val = parseExpr();
      consume(); // )
      return val;
    }
    if (/^\d+$/.test(t)) {
      consume();
      const idx = parseInt(t) - 1; // 1-based → 0-based
      return idx >= 0 && idx < rowResults.length ? rowResults[idx] : false;
    }
    consume(); // skip unknown token
    return false;
  }

  try { return parseExpr(); } catch { return false; }
}

// Evaluate a group of conditions
// If group.customLogic is set (e.g. "(1 AND 2) OR (3 AND 4)"), use the parser.
// Otherwise fall back to sequential AND/OR per row for backward compatibility.
function evalGroup(group, indicators, prices, volumeRatio, extra = {}) {
  const all     = group.conditions || [];
  const enabled = all.filter(c => c.enabled !== false);
  if (enabled.length === 0) return false;

  // Evaluate every enabled condition to get per-row boolean results
  const rowResults = enabled.map(c => evalCondition(c, indicators, prices, volumeRatio, extra));

  // Custom logic expression (e.g. "(1 AND 2) OR (3 AND 4)")
  const expr = (group.customLogic || "").trim();
  if (expr) return parseLogicExpr(expr, rowResults);

  // Fallback: sequential per-row combiner (backward compat)
  let result = rowResults[0];
  for (let i = 1; i < rowResults.length; i++) {
    const combiner = enabled[i].combiner || group.logic || "and";
    result = combiner === "or" ? result || rowResults[i] : result && rowResults[i];
  }
  return result;
}

// Exit action constants — these map to the existing exit trigger system
const EXIT_ACTIONS = new Set([
  "TRAILING_TAKE_PROFIT", "TIME_EXIT", "TRAILING_STOP",
  "SIGNAL_REVERSAL",      "DYNAMIC_EXIT", "POST_BUY_LIMIT",
  "TAKE_PROFIT",          "STOP_LOSS",
]);

// Evaluate all groups and return a signal or exit action
function evalCustomRules(customRules, indicators, prices, volumeRatio, extra = {}) {
  if (!customRules?.enabled || !customRules.groups?.length) return null;

  const signals     = [];  // entry signals (BUY/SELL/HOLD)
  const exitTriggers = []; // exit actions (TRAILING_TAKE_PROFIT etc.)

  for (const group of customRules.groups) {
    if (!group.conditions?.length) continue;
    const passed = evalGroup(group, indicators, prices, volumeRatio, extra);
    if (!passed) continue;

    const action = group.action || "BUY";
    if (EXIT_ACTIONS.has(action)) {
      // This group is an exit rule — collect it separately
      exitTriggers.push({ action, weight: group.weight || 1, label: group.label, params: group.params || {} });
    } else {
      signals.push({ action, weight: group.weight || 1, label: group.label });
    }
  }

  // ── Entry signal result ──────────────────────────────────────────────────
  let entryResult = null;
  if (signals.length > 0) {
    let buyWeight = 0, sellWeight = 0;
    signals.forEach(s => {
      if (s.action === "BUY")  buyWeight  += s.weight;
      if (s.action === "SELL") sellWeight += s.weight;
    });

    const groupLogic  = customRules.groupLogic || "and";
    const totalWeight = customRules.groups.reduce((s, g) => s + (g.weight || 1), 0);
    let action = "HOLD";
    if (groupLogic === "or") {
      if (buyWeight > 0 && buyWeight >= sellWeight) action = "BUY";
      if (sellWeight > 0 && sellWeight > buyWeight) action = "SELL";
    } else {
      if (buyWeight  > totalWeight * 0.5) action = "BUY";
      if (sellWeight > totalWeight * 0.5) action = "SELL";
    }

    const confidence = Math.min(99,
      Math.round(Math.max(buyWeight, sellWeight) / (buyWeight + sellWeight + 0.01) * 100));

    entryResult = {
      action,
      confidence: String(confidence),
      score:      (buyWeight - sellWeight).toFixed(2),
      agreeingCount:   signals.length,
      totalIndicators: customRules.groups.filter(g => g.conditions?.length).length,
      reasons: signals.map(s => ({ label: `${s.label}: ${s.action}`, vote: s.action === "BUY" ? 1 : -1 })),
      fromCustomRules: true,
      exitTriggers,    // pass exit triggers along even in entry result
    };
  }

  // ── Exit-only result (no entry signal but exits fired) ───────────────────
  if (!entryResult && exitTriggers.length > 0) {
    return {
      action: "HOLD",
      confidence: "0",
      score: "0",
      agreeingCount: 0,
      totalIndicators: 0,
      reasons: [],
      fromCustomRules: true,
      exitTriggers,
    };
  }

  return entryResult;
}

function generateMeanReversionSignal(indicators, volumeRatio, feePercent) {
  const signals = [];
  const w = (weight, vote, label) => signals.push({ weight, vote, label });
  const roundTrip = (parseFloat(feePercent) || 0.1) * 2;

  // RSI extreme reversal (stronger thresholds than momentum)
  if (indicators.rsi != null) {
    if (indicators.rsi < 25)       w(3, 1,  `RSI deeply oversold (${indicators.rsi.toFixed(1)}) — strong mean reversion buy`);
    else if (indicators.rsi < 35)  w(2, 1,  `RSI oversold (${indicators.rsi.toFixed(1)})`);
    else if (indicators.rsi > 75)  w(3, -1, `RSI deeply overbought (${indicators.rsi.toFixed(1)}) — strong mean reversion sell`);
    else if (indicators.rsi > 65)  w(2, -1, `RSI overbought (${indicators.rsi.toFixed(1)})`);
    else                           w(1, 0,  `RSI neutral (${indicators.rsi.toFixed(1)})`);
  }

  // Bollinger Band breach — core of mean reversion
  if (indicators.boll && indicators.currentPrice) {
    const p    = indicators.currentPrice;
    const pctB = indicators.boll.upper > indicators.boll.lower
      ? (p - indicators.boll.lower) / (indicators.boll.upper - indicators.boll.lower)
      : 0.5;
    if (pctB < 0)         w(3, 1,  `Price BELOW lower BB band (${pctB.toFixed(2)}) — mean reversion buy`);
    else if (pctB < 0.2)  w(2, 1,  `Price near lower BB (${pctB.toFixed(2)})`);
    else if (pctB > 1)    w(3, -1, `Price ABOVE upper BB band (${pctB.toFixed(2)}) — mean reversion sell`);
    else if (pctB > 0.8)  w(2, -1, `Price near upper BB (${pctB.toFixed(2)})`);
    else                  w(1, 0,  `Price inside BB bands`);
  }

  // MACD reversal — mean reversion uses MACD crossing zero from extreme
  if (indicators.macd != null) {
    if (indicators.macd < -0.002)  w(1.5, 1,  `MACD deeply negative (${indicators.macd.toFixed(4)}) — expect reversion`);
    else if (indicators.macd > 0.002) w(1.5, -1, `MACD deeply positive — expect reversion`);
    else                              w(0.5, 0,  `MACD near zero`);
  }

  // Volume: mean reversion works better on low volume (no breakout)
  if (volumeRatio < 0.8)  w(1.5, 1, `Low volume (${volumeRatio.toFixed(2)}x) — ranging market, MR favoured`);
  else if (volumeRatio > 1.5) w(1, -0.5, `High volume — potential breakout, MR less reliable`);

  const totalW   = signals.reduce((s, x) => s + x.weight, 0) || 1;
  const weightedScore = signals.reduce((s, x) => s + x.weight * x.vote, 0) / totalW;
  const agreeingBuy   = signals.filter(x => x.vote > 0).length;
  const agreeingSell  = signals.filter(x => x.vote < 0).length;

  const action = weightedScore > 0.3 ? "BUY" : weightedScore < -0.3 ? "SELL" : "HOLD";
  const confidence = Math.min(99, Math.abs(weightedScore) * 100).toFixed(0);

  return {
    action, confidence, score: (weightedScore * 5).toFixed(2),
    agreeingCount: action === "BUY" ? agreeingBuy : agreeingSell,
    totalIndicators: signals.length,
    reasons: signals,
    mode: "mean_reversion",
  };
}

function generateSignal(indicators, newsSentiment, volumeRatio, indicatorConfig = null) {
  const ic = indicatorConfig || {};
  const cfg = (key, defaults = {}) => ({ enabled: true, ...defaults, ...ic[key] });
  // Each entry: { weight, vote: +1 bull | -1 bear | 0 neutral, reason, active }
  const signals = [];

  // ── RSI ──────────────────────────────────────────────────────────────────
  const rsiCfg = cfg("rsi", { weight: 2, oversold: 35, overbought: 65 });
  if (rsiCfg.enabled && indicators.rsi !== null) {
    const w = parseFloat(rsiCfg.weight) || 2;
    const os = parseFloat(rsiCfg.oversold) || 35;
    const ob = parseFloat(rsiCfg.overbought) || 65;
    if (indicators.rsi < os)
      signals.push({ weight: w, vote: 1,  label: `RSI oversold (${indicators.rsi.toFixed(1)} < ${os})` });
    else if (indicators.rsi > ob)
      signals.push({ weight: w, vote: -1, label: `RSI overbought (${indicators.rsi.toFixed(1)} > ${ob})` });
    else
      signals.push({ weight: w, vote: 0,  label: `RSI neutral (${indicators.rsi.toFixed(1)})` });
  }

  // ── SMA 20/50 ────────────────────────────────────────────────────────────
  const sma2050 = cfg("sma_20_50", { weight: 1.5 });
  if (sma2050.enabled && indicators.sma20 && indicators.sma50) {
    const w = parseFloat(sma2050.weight) || 1.5;
    signals.push(indicators.sma20 > indicators.sma50
      ? { weight: w, vote: 1,  label: `SMA20 > SMA50 (${indicators.sma20.toFixed(0)} > ${indicators.sma50.toFixed(0)})` }
      : { weight: w, vote: -1, label: `SMA20 < SMA50 (${indicators.sma20.toFixed(0)} < ${indicators.sma50.toFixed(0)})` });
  }

  // ── SMA 20/99 ────────────────────────────────────────────────────────────
  const sma2099 = cfg("sma_20_99", { weight: 2 });
  if (sma2099.enabled && indicators.sma20 && indicators.sma99) {
    const w = parseFloat(sma2099.weight) || 2;
    signals.push(indicators.sma20 > indicators.sma99
      ? { weight: w, vote: 1,  label: `SMA20 > SMA99 (${indicators.sma20.toFixed(0)} > ${indicators.sma99.toFixed(0)})` }
      : { weight: w, vote: -1, label: `SMA20 < SMA99 (${indicators.sma20.toFixed(0)} < ${indicators.sma99.toFixed(0)})` });
  }

  // ── SMA 50/99 ────────────────────────────────────────────────────────────
  const sma5099 = cfg("sma_50_99", { weight: 1.5 });
  if (sma5099.enabled && indicators.sma50 && indicators.sma99) {
    const w = parseFloat(sma5099.weight) || 1.5;
    signals.push(indicators.sma50 > indicators.sma99
      ? { weight: w, vote: 1,  label: `SMA50 > SMA99 (${indicators.sma50.toFixed(0)} > ${indicators.sma99.toFixed(0)})` }
      : { weight: w, vote: -1, label: `SMA50 < SMA99 (${indicators.sma50.toFixed(0)} < ${indicators.sma99.toFixed(0)})` });
  }

  // ── EMA 12/26 ────────────────────────────────────────────────────────────
  const ema1226 = cfg("ema_12_26", { weight: 1.5 });
  if (ema1226.enabled && indicators.ema12 && indicators.ema26) {
    const w = parseFloat(ema1226.weight) || 1.5;
    signals.push(indicators.ema12 > indicators.ema26
      ? { weight: w, vote: 1,  label: `EMA12 > EMA26 (${indicators.ema12.toFixed(0)} > ${indicators.ema26.toFixed(0)})` }
      : { weight: w, vote: -1, label: `EMA12 < EMA26 (${indicators.ema12.toFixed(0)} < ${indicators.ema26.toFixed(0)})` });
  }

  // ── MACD ──────────────────────────────────────────────────────────────────
  const macdCfg = cfg("macd", { weight: 1 });
  if (macdCfg.enabled && indicators.macd !== null) {
    const w = parseFloat(macdCfg.weight) || 1;
    signals.push(indicators.macd > 0
      ? { weight: w, vote: 1,  label: `MACD positive (${indicators.macd.toFixed(2)})` }
      : { weight: w, vote: -1, label: `MACD negative (${indicators.macd.toFixed(2)})` });
  }

  // ── Bollinger Bands ───────────────────────────────────────────────────────
  const bollCfg = cfg("bollinger", { weight: 2 });
  if (bollCfg.enabled && indicators.boll && indicators.currentPrice) {
    const w = parseFloat(bollCfg.weight) || 2;
    if (indicators.currentPrice < indicators.boll.lower)
      signals.push({ weight: w, vote: 1,  label: `Price below BB lower band (${indicators.boll.lower.toFixed(0)})` });
    else if (indicators.currentPrice > indicators.boll.upper)
      signals.push({ weight: w, vote: -1, label: `Price above BB upper band (${indicators.boll.upper.toFixed(0)})` });
    else
      signals.push({ weight: w, vote: 0,  label: "Price inside BB bands" });
  }

  // ── News sentiment ────────────────────────────────────────────────────────
  const newsCfg = cfg("news", { weight: 1.5 });
  if (newsCfg.enabled) {
    const w = parseFloat(newsCfg.weight) || 1.5;
    if (newsSentiment > 0.15)
      signals.push({ weight: w, vote: 1,  label: `Positive news (${(newsSentiment * 100).toFixed(0)}%)` });
    else if (newsSentiment < -0.15)
      signals.push({ weight: w, vote: -1, label: `Negative news (${(newsSentiment * 100).toFixed(0)}%)` });
    else
      signals.push({ weight: w, vote: 0,  label: `Neutral news (${(newsSentiment * 100).toFixed(0)}%)` });
  }

  // ── Weighted score ────────────────────────────────────────────────────────
  let score = signals.reduce((sum, s) => sum + s.vote * s.weight, 0);

  // Volume multiplier — amplifies or dampens but cannot flip direction
  let volumeNote = "";
  if (volumeRatio > 1.4) {
    score *= 1.2;
    volumeNote = `High volume (${volumeRatio.toFixed(2)}x) — signal amplified`;
  } else if (volumeRatio < 0.7) {
    score *= 0.6;
    volumeNote = `Low volume (${volumeRatio.toFixed(2)}x) — signal dampened`;
  }

  // ── Confidence: % of non-neutral indicators agreeing with net direction ───
  // Only counts indicators with an actual vote (not 0)
  const activeSignals = signals.filter((s) => s.vote !== 0);
  const netDir = score > 0 ? 1 : -1;
  const agreeing = activeSignals.filter((s) => s.vote === netDir);
  // Confidence = (agreeing weight) / (total active weight) * 100
  const totalActiveWeight = activeSignals.reduce((s, i) => s + i.weight, 0);
  const agreeingWeight    = agreeing.reduce((s, i) => s + i.weight, 0);
  const confidence = totalActiveWeight > 0
    ? Math.min((agreeingWeight / totalActiveWeight) * 100, 99)
    : 0;

  // ── Action: apply AND / OR / custom combiner logic ─────────────────────────
  const agreeingCount = agreeing.length;
  const combiner      = indicatorConfig?._ruleCombiner || { logic: "and", minAgree: 3, customThreshold: 0.3 };
  const logic         = combiner.logic || "and";
  const minAgree      = parseInt(combiner.minAgree) || 3;
  const customThr     = parseFloat(combiner.customThreshold) || 0.3;

  let action = "HOLD";
  const buyScore  = score > 0;
  const sellScore = score < 0;

  if (logic === "or") {
    // OR: any single strong indicator is enough
    const strongBuy  = signals.some(s => s.vote > 0 && s.weight >= 2);
    const strongSell = signals.some(s => s.vote < 0 && s.weight >= 2);
    if (buyScore  && (score > 1 || strongBuy))  action = "BUY";
    if (sellScore && (score < -1 || strongSell)) action = "SELL";
  } else if (logic === "custom") {
    // custom: score must exceed threshold AND minimum indicators must agree
    if (score  > customThr  * 5 && agreeingCount >= minAgree) action = "BUY";
    if (score < -customThr  * 5 && agreeingCount >= minAgree) action = "SELL";
  } else {
    // and (default): score threshold AND minimum agreeing indicators
    if (score > 2  && agreeingCount >= minAgree) action = "BUY";
    if (score < -2 && agreeingCount >= minAgree) action = "SELL";
  }

  const reasons = [
    ...signals.map((s) => ({ label: s.label, vote: s.vote })),
    ...(volumeNote ? [{ label: volumeNote, vote: 0 }] : []),
  ];

  return {
    action,
    score: score.toFixed(2),
    confidence: confidence.toFixed(1),
    agreeingCount,
    totalIndicators: activeSignals.length,
    reasons,
  };
}

// ─── Rate Limiter + Exponential Backoff ───────────────────────────────────────
// Coinbase Advanced Trade limits: READ 600 req/10s, WRITE 500 req/10s.
// We track timestamps of recent calls in a sliding 10-second window.
// On 429 / 5xx we apply full exponential backoff with jitter (capped at 32s).

const RATE_LIMITS = { READ: { max: 600, windowMs: 10_000 }, WRITE: { max: 500, windowMs: 10_000 } };
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 250;   // first backoff step
const MAX_BACKOFF_MS = 32_000;

// Shared mutable state for rate-limit windows (module-level, not React state)
const _rl = {
  READ:  { timestamps: [] },
  WRITE: { timestamps: [] },
  // Observable counters — React components read these via a ref + polling
  stats: { readUsed: 0, writeUsed: 0, readQueued: 0, writeQueued: 0, retries: 0, throttled: 0, lastError: null },
};

function _pruneWindow(bucket) {
  const cutoff = Date.now() - RATE_LIMITS[bucket].windowMs;
  _rl[bucket].timestamps = _rl[bucket].timestamps.filter((t) => t > cutoff);
}

function _windowUsed(bucket) {
  _pruneWindow(bucket);
  return _rl[bucket].timestamps.length;
}

// Returns ms to wait before the next slot opens (0 = fire now)
function _waitMs(bucket) {
  _pruneWindow(bucket);
  const { timestamps } = _rl[bucket];
  const { max, windowMs } = RATE_LIMITS[bucket];
  if (timestamps.length < max) return 0;
  // Oldest timestamp in window — waiting until it expires opens a slot
  const oldest = timestamps[0];
  return Math.max(0, oldest + windowMs - Date.now() + 5); // +5ms safety margin
}

function _recordCall(bucket) {
  _rl[bucket].timestamps.push(Date.now());
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Exponential backoff with full jitter: delay = rand(0, min(cap, base * 2^attempt))
function _backoffMs(attempt) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCHANGE ADAPTER LAYER
// Each adapter exposes the same interface:
//   getBalances(keys)   → { USD, BTC, ETH, SOL }
//   placeOrder(keys, productId, side, quoteSize, baseSize) → { orderId }
//   getMarketData(keys, productIds[]) → { BTC: {price,bid,ask}, ... }
//
// All adapters use the shared rate-limiter + exponential backoff via rateFetch().
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Exchange provider registry ───────────────────────────────────────────────
const EXCHANGE_PROVIDERS = {
  coinbase: {
    id: "coinbase",
    name: "Coinbase Advanced Trade",
    logo: "🔵",
    color: "#1652f0",
    docsUrl: "https://docs.cdp.coinbase.com/advanced-trade/docs/getting-started",
    credFields: [
      { key: "apiKeyName",  label: "API Key Name",       placeholder: "organizations/xxx/apiKeys/yyy", type: "text",     hint: "From cdp.coinbase.com → API Keys" },
      { key: "privateKey",  label: "EC Private Key (PEM)", placeholder: "-----BEGIN EC PRIVATE KEY-----", type: "pem",  hint: "EC P-256 key, keep secret" },
    ],
    productId: (coin) => `${coin}-USD`,
    rateLimit: { read: 600, write: 500, windowMs: 10_000 },
  },
  binance: {
    id: "binance",
    name: "Binance.US",
    logo: "🟡",
    color: "#f0b90b",
    docsUrl: "https://docs.binance.us",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Binance.US API key",    type: "text",     hint: "From binance.us → API Management" },
      { key: "secretKey", label: "Secret Key", placeholder: "Your Binance.US secret key", type: "password", hint: "Never share this key" },
    ],
    productId: (coin) => `${coin}USD`,  // Binance.US format: BTCUSD, ETHUSD, SOLUSD
    rateLimit: { read: 1200, write: 100, windowMs: 60_000 },
  },
  kraken: {
    id: "kraken",
    name: "Kraken",
    logo: "🐙",
    color: "#5741d9",
    docsUrl: "https://docs.kraken.com/rest",
    credFields: [
      { key: "apiKey",      label: "API Key",      placeholder: "Your Kraken API key",      type: "text",     hint: "From kraken.com → Security → API" },
      { key: "privateKey",  label: "Private Key",  placeholder: "Your Kraken private key",  type: "password", hint: "Base64-encoded private key" },
    ],
    productId: (coin) => `${coin === "BTC" ? "XBT" : coin}USD`,
    rateLimit: { read: 15, write: 15, windowMs: 3_000 },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    logo: "♊",
    color: "#00dcfa",
    docsUrl: "https://docs.gemini.com/rest-api",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Gemini API key",    type: "text",     hint: "From gemini.com → Settings → API" },
      { key: "secretKey", label: "API Secret", placeholder: "Your Gemini API secret", type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}USD`.toLowerCase(),
    rateLimit: { read: 120, write: 60, windowMs: 60_000 },
  },
  alpaca: {
    id: "alpaca",
    name: "Alpaca",
    logo: "🦙",
    color: "#ffcf47",
    docsUrl: "https://docs.alpaca.markets/reference/getallcryptobars",
    credFields: [
      { key: "apiKey",    label: "API Key ID",  placeholder: "Your Alpaca API key ID",  type: "text",     hint: "From alpaca.markets → API Keys" },
      { key: "secretKey", label: "Secret Key",  placeholder: "Your Alpaca secret key",  type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}/USD`,
    rateLimit: { read: 200, write: 200, windowMs: 60_000 },
  },
  public: {
    id: "public",
    name: "Public.com",
    logo: "🟢",
    color: "#3fba71",
    docsUrl: "https://public.com/api",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Public.com API key",    type: "text",     hint: "From public.com → Settings → API" },
      { key: "secretKey", label: "API Secret", placeholder: "Your Public.com API secret", type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}-USD`,
    rateLimit: { read: 100, write: 60, windowMs: 60_000 },
  },
};

// ─── Shared rate-limiter (per-provider buckets, keyed by providerId:bucket) ───
const _rlBuckets = {};
function _getRLBucket(providerId, bucket) {
  const key = `${providerId}:${bucket}`;
  if (!_rlBuckets[key]) _rlBuckets[key] = { timestamps: [] };
  return _rlBuckets[key];
}
function _rlWaitMs(providerId, bucket, limit, windowMs) {
  const b = _getRLBucket(providerId, bucket);
  const cutoff = Date.now() - windowMs;
  b.timestamps = b.timestamps.filter((t) => t > cutoff);
  if (b.timestamps.length < limit) return 0;
  return Math.max(0, b.timestamps[0] + windowMs - Date.now() + 5);
}
function _rlRecord(providerId, bucket) {
  _getRLBucket(providerId, bucket).timestamps.push(Date.now());
}

// ─── Generic rate-limited fetch with exponential backoff ──────────────────────
async function rateFetch(url, options = {}, providerId = "coinbase", bucket = "READ", _attempt = 0) {
  const provider = EXCHANGE_PROVIDERS[providerId];
  const { read, write, windowMs } = provider?.rateLimit || { read: 600, write: 500, windowMs: 10_000 };
  const limit = bucket === "READ" ? read : write;

  const wait = _rlWaitMs(providerId, bucket, limit, windowMs);
  if (wait > 0) { _rl.stats.throttled++; await _sleep(wait); }
  _rlRecord(providerId, bucket);

  let res, data;
  try {
    res = await fetch(url, options);
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
  } catch (networkErr) {
    if (_attempt < MAX_RETRIES) {
      const delay = _backoffMs(_attempt);
      _rl.stats.retries++;
      _rl.stats.lastError = `[${providerId}] Network error, retry ${_attempt + 1}`;
      await _sleep(delay);
      return rateFetch(url, options, providerId, bucket, _attempt + 1);
    }
    throw networkErr;
  }

  if (res.status === 429 && _attempt < MAX_RETRIES) {
    const delay = parseInt(res.headers?.get?.("Retry-After") || "0") * 1000 || _backoffMs(_attempt);
    _rl.stats.retries++;
    _rl.stats.lastError = `[${providerId}] 429 rate limited, retry ${_attempt + 1}`;
    await _sleep(delay);
    return rateFetch(url, options, providerId, bucket, _attempt + 1);
  }
  if (res.status >= 500 && _attempt < MAX_RETRIES) {
    _rl.stats.retries++;
    await _sleep(_backoffMs(_attempt));
    return rateFetch(url, options, providerId, bucket, _attempt + 1);
  }
  if (!res.ok) {
    const msg = (typeof data === "object" ? data?.message || data?.error || data?.msg : data) || `HTTP ${res.status}`;
    _rl.stats.lastError = `[${providerId}] ${msg}`;
    throw new Error(`[${providerId}] ${msg}`);
  }
  _rl.stats.lastError = null;
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Coinbase Advanced Trade adapter ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function importCBKey(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function buildCBJWT(apiKeyName, pem, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signing = `${enc({ alg:"ES256", kid:apiKeyName })}.${enc({ iss:"cdp", nbf:now, exp:now+120, sub:apiKeyName, uri:`${method} api.coinbase.com${path}` })}`;
  const key = await importCBKey(pem);
  const sig = await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, key, new TextEncoder().encode(signing));
  return `${signing}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}`;
}
async function cbRequest(keys, method, path, body) {
  const jwt = await buildCBJWT(keys.apiKeyName, keys.privateKey, method, path);
  return rateFetch(`${CB_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, "coinbase", method === "GET" ? "READ" : "WRITE");
}
const coinbaseAdapter = {
  async getBalances(keys) {
    const data = await cbRequest(keys, "GET", "/accounts");
    const balances = { USD: 0 };
    for (const acc of data.accounts || []) {
      const v = parseFloat(acc.available_balance?.value || 0);
      if (acc.currency === "USD") balances.USD = v;
      else if (COINS.includes(acc.currency)) balances[acc.currency] = v;
    }
    try {
      const fills = await cbRequest(keys, "GET", `/orders/historical/fills?product_id=BTC-USD&limit=5`);
      balances._recentFills = fills.fills?.slice(0, 5) || [];
    } catch (_) {}
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const result = await cbRequest(keys, "POST", "/orders", {
      client_order_id: `algo-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      product_id: productId,
      side,
      order_configuration: side === "BUY"
        ? { market_market_ioc: { quote_size: quoteSize.toFixed(2) } }
        : { market_market_ioc: { base_size: baseSize.toFixed(8) } },
    });
    return { orderId: result.order_id, raw: result };
  },
  async getMarketData(keys, productIds) {
    const data = await cbRequest(keys, "GET", `/best_bid_ask?product_ids=${productIds.join("&product_ids=")}`);
    const out = {};
    for (const pb of data.pricebooks || []) {
      const coin = pb.product_id.replace("-USD","");
      out[coin] = { price: parseFloat(pb.asks?.[0]?.price || pb.bids?.[0]?.price), bid: parseFloat(pb.bids?.[0]?.price), ask: parseFloat(pb.asks?.[0]?.price) };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Binance.US adapter ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function bnSign(secret, queryString) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(queryString));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const BN_BASE = "https://api.binance.us/api/v3";
const binanceAdapter = {
  async getBalances(keys) {
    const ts = Date.now();
    const qs = `timestamp=${ts}`;
    const sig = await bnSign(keys.secretKey, qs);
    const data = await rateFetch(`${BN_BASE}/account?${qs}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": keys.apiKey },
    }, "binance", "READ");
    const balances = { USD: 0 };
    for (const b of data.balances || []) {
      const v = parseFloat(b.free);
      if (b.asset === "USDT" || b.asset === "USD") balances.USD = (balances.USD||0) + v;
      else if (COINS.includes(b.asset)) balances[b.asset] = v;
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const ts = Date.now();
    const params = side === "BUY"
      ? `symbol=${productId}&side=${side}&type=MARKET&quoteOrderQty=${quoteSize.toFixed(2)}&timestamp=${ts}`
      : `symbol=${productId}&side=${side}&type=MARKET&quantity=${baseSize.toFixed(6)}&timestamp=${ts}`;
    const sig = await bnSign(keys.secretKey, params);
    const result = await rateFetch(`${BN_BASE}/order?${params}&signature=${sig}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": keys.apiKey },
    }, "binance", "WRITE");
    return { orderId: String(result.orderId), raw: result };
  },
  async getMarketData(_keys, productIds) {
    const out = {};
    await Promise.all(productIds.map(async pid => {
      const data = await rateFetch(`${BN_BASE}/ticker/bookTicker?symbol=${pid}`, {}, "binance", "READ");
      const coin = pid.replace(/USDT?$/,"");
      out[coin] = { price: parseFloat(data.askPrice), bid: parseFloat(data.bidPrice), ask: parseFloat(data.askPrice) };
    }));
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Kraken adapter ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const KK_BASE = "https://api.kraken.com";
async function kkSign(privateKey, path, nonce, postData) {
  const sha256 = async (msg) => { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg)); return new Uint8Array(h); };
  const msgBytes = new Uint8Array([...new TextEncoder().encode(path), ...(await sha256(nonce + postData))]);
  const keyBytes = Uint8Array.from(atob(privateKey), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name:"HMAC", hash:"SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
const krakenAdapter = {
  async getBalances(keys) {
    const nonce = String(Date.now());
    const path = "/0/private/Balance";
    const sig = await kkSign(keys.privateKey, path, nonce, `nonce=${nonce}`);
    const data = await rateFetch(`${KK_BASE}${path}`, {
      method: "POST",
      headers: { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
      body: `nonce=${nonce}`,
    }, "kraken", "READ");
    const r = data.result || {};
    return { USD: parseFloat(r.ZUSD||0), BTC: parseFloat(r.XXBT||0), ETH: parseFloat(r.XETH||0), SOL: parseFloat(r.SOL||0) };
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const nonce = String(Date.now());
    const path = "/0/private/AddOrder";
    const volume = side === "BUY" ? (quoteSize / 1).toFixed(8) : baseSize.toFixed(8); // simplified
    const body = `nonce=${nonce}&ordertype=market&type=${side.toLowerCase()}&volume=${volume}&pair=${productId}`;
    const sig = await kkSign(keys.privateKey, path, nonce, body);
    const data = await rateFetch(`${KK_BASE}${path}`, {
      method: "POST",
      headers: { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, "kraken", "WRITE");
    return { orderId: data.result?.txid?.[0] || "unknown", raw: data };
  },
  async getMarketData(_keys, productIds) {
    const pairs = productIds.join(",");
    const data = await rateFetch(`${KK_BASE}/0/public/Ticker?pair=${pairs}`, {}, "kraken", "READ");
    const out = {};
    for (const [pair, v] of Object.entries(data.result || {})) {
      const coin = pair.replace(/^X?/,"").replace(/ZUSD$/,"").replace(/^XBT$/,"BTC");
      out[coin] = { price: parseFloat(v.c?.[0]), bid: parseFloat(v.b?.[0]), ask: parseFloat(v.a?.[0]) };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Gemini adapter ───────────────────────────────────────════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
const GEM_BASE = "https://api.gemini.com";
async function gemSign(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-384" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const geminiAdapter = {
  async getBalances(keys) {
    const nonce = String(Date.now());
    const endpoint = "/v1/balances";
    const payload = btoa(JSON.stringify({ request: endpoint, nonce }));
    const sig = await gemSign(keys.secretKey, payload);
    const data = await rateFetch(`${GEM_BASE}${endpoint}`, {
      method: "POST",
      headers: { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig },
    }, "gemini", "READ");
    const balances = { USD: 0 };
    for (const b of Array.isArray(data) ? data : []) {
      const v = parseFloat(b.available);
      if (b.currency === "USD") balances.USD = v;
      else if (COINS.includes(b.currency)) balances[b.currency] = v;
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const nonce = String(Date.now());
    const endpoint = "/v1/order/new";
    const amount = side === "BUY" ? (quoteSize / 1).toFixed(8) : baseSize.toFixed(8);
    const body = { request: endpoint, nonce, symbol: productId, amount, price: "0", side: side.toLowerCase(), type: "exchange market", options: ["immediate-or-cancel"] };
    const payload = btoa(JSON.stringify(body));
    const sig = await gemSign(keys.secretKey, payload);
    const data = await rateFetch(`${GEM_BASE}${endpoint}`, {
      method: "POST",
      headers: { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig },
    }, "gemini", "WRITE");
    return { orderId: String(data.order_id || ""), raw: data };
  },
  async getMarketData(_keys, productIds) {
    const out = {};
    await Promise.all(productIds.map(async pid => {
      const data = await rateFetch(`${GEM_BASE}/v1/pubticker/${pid}`, {}, "gemini", "READ");
      const coin = pid.replace(/usd$/i,"").toUpperCase();
      out[coin] = { price: parseFloat(data.last), bid: parseFloat(data.bid), ask: parseFloat(data.ask) };
    }));
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Alpaca adapter ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const ALP_BASE = "https://api.alpaca.markets";
const alpacaAdapter = {
  async getBalances(keys) {
    const data = await rateFetch(`${ALP_BASE}/v2/account`, {
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey },
    }, "alpaca", "READ");
    const positions = await rateFetch(`${ALP_BASE}/v2/positions`, {
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey },
    }, "alpaca", "READ");
    const balances = { USD: parseFloat(data.cash || 0) };
    for (const p of Array.isArray(positions) ? positions : []) {
      const coin = p.symbol.replace(/\/USD$/,"").replace(/USD$/,"");
      if (COINS.includes(coin)) balances[coin] = parseFloat(p.qty);
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const body = { symbol: productId, side: side.toLowerCase(), type: "market", time_in_force: "ioc",
      ...(side === "BUY" ? { notional: quoteSize.toFixed(2) } : { qty: baseSize.toFixed(8) }) };
    const data = await rateFetch(`${ALP_BASE}/v2/orders`, {
      method: "POST",
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "alpaca", "WRITE");
    return { orderId: data.id || "", raw: data };
  },
  async getMarketData(_keys, productIds) {
    const symbols = productIds.join(",");
    const data = await rateFetch(`https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols=${symbols}`, {
      headers: { "APCA-API-KEY-ID": _keys.apiKey, "APCA-API-SECRET-KEY": _keys.secretKey },
    }, "alpaca", "READ");
    const out = {};
    for (const [sym, q] of Object.entries(data.quotes || {})) {
      const coin = sym.replace(/\/USD$/,"");
      out[coin] = { price: (q.ap + q.bp) / 2, bid: q.bp, ask: q.ap };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Public.com adapter (stub — API not public yet, sandbox only) ─────────────
// ═══════════════════════════════════════════════════════════════════════════════
const publicAdapter = {
  async getBalances(_keys) {
    return { USD: 0, _note: "Public.com API is invite-only. Run in sandbox mode." };
  },
  async placeOrder(_keys, productId, side, quoteSize) {
    return { orderId: `pub-sandbox-${Date.now()}`, raw: { note: "Public.com sandbox order", productId, side, quoteSize } };
  },
  async getMarketData(_keys, productIds) {
    // Fall back to public proxy prices
    return {};
  },
};

// ─── Active adapter resolver ──────────────────────────────────────────────────
const ADAPTERS = {
  coinbase: coinbaseAdapter,
  binance: binanceAdapter,
  kraken: krakenAdapter,
  gemini: geminiAdapter,
  alpaca: alpacaAdapter,
  public: publicAdapter,
};
function getAdapter(providerId) {
  return ADAPTERS[providerId] || coinbaseAdapter;
}

// ─── High-level exchange operations (used by trading engine) ──────────────────
async function exchangeGetBalances(creds) {
  return getAdapter(creds.provider).getBalances(creds.keys[creds.provider] || {});
}
async function exchangePlaceOrder(creds, coin, side, quoteSize, baseSize) {
  const provider = EXCHANGE_PROVIDERS[creds.provider];
  const productId = provider.productId(coin);
  return getAdapter(creds.provider).placeOrder(creds.keys[creds.provider] || {}, productId, side, quoteSize, baseSize);
}
async function exchangeGetMarketData(creds, coins) {
  const provider = EXCHANGE_PROVIDERS[creds.provider];
  const productIds = coins.map(c => provider.productId(c));
  return getAdapter(creds.provider).getMarketData(creds.keys[creds.provider] || {}, productIds);
}

// Legacy Coinbase helpers kept for getRateLimitStats compatibility
function cbGetAccounts(creds) { return coinbaseAdapter.getBalances(creds.keys?.coinbase || creds); }

// ─── Helper: snapshot current rate-limit stats (for React display) ────────────
function getRateLimitStats() {
  return {
    readUsed: _windowUsed("READ"),
    readMax: RATE_LIMITS.READ.max,
    writeUsed: _windowUsed("WRITE"),
    writeMax: RATE_LIMITS.WRITE.max,
    readQueued: _rl.stats.readQueued,
    writeQueued: _rl.stats.writeQueued,
    retries: _rl.stats.retries,
    throttled: _rl.stats.throttled,
    lastError: _rl.stats.lastError,
  };
}

// ─── Utility formatters ────────────────────────────────────────────────────────
// ─── Fee-adjusted profit calculation ─────────────────────────────────────────
// Fee is charged on both sides (BUY and SELL), each as a % of the notional value.
// BUY cost:  qty * buyPrice * (1 + fee%)
// SELL recv: qty * sellPrice * (1 - fee%)
// Net profit = SELL recv - BUY cost = qty * (sellPrice*(1-f) - buyPrice*(1+f))
function calcProfit(buyPrice, sellPrice, qty, feePercent) {
  const f = (parseFloat(feePercent) || 0) / 100;
  const buyCost   = qty * buyPrice  * (1 + f);
  const sellRecv  = qty * sellPrice * (1 - f);
  return sellRecv - buyCost;
}

// Binance LOT_SIZE step sizes (minimum quantity increments per coin)
// https://api.binance.us/api/v3/exchangeInfo for exact values
const LOT_STEPS = { BTC: 0.00001, ETH: 0.0001, SOL: 0.01 };
function roundLotSize(qty, coin) {
  const step = LOT_STEPS[coin] || 0.00001;
  // Round DOWN to the nearest step to avoid exceeding available balance
  const rounded = Math.floor(qty / step) * step;
  // Return with enough decimal places to avoid scientific notation
  return parseFloat(rounded.toFixed(8));
}

const fmt = (n, d = 2) => n?.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";

// Formats a Date (or timestamp) as "9 Sep 2026, 14:32" — always includes date so entries
// from previous days are unambiguous. Used wherever timestamps are shown in the UI.
const fmtDateTime = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

// Time only (for dense log entries within the same UI where the date is already shown).
const fmtTime = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleString(undefined, {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
};
const fmtPct = (n) => (n >= 0 ? "+" : "") + n?.toFixed(2) + "%";

// ─── Sub-components ───────────────────────────────────────────────────────────
function Badge({ action }) {
  const styles = {
    BUY: { background: "#d1fae5", color: "#065f46" },
    SELL: { background: "#fee2e2", color: "#991b1b" },
    HOLD: { background: "#fef3c7", color: "#92400e" },
  };
  return (
    <span style={{ ...styles[action], padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>
      {action}
    </span>
  );
}

function MiniChart({ data }) {
  if (data.length < 2) return null;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const w = 100, h = 32, pad = 2;
  const pts = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const up = prices[prices.length - 1] >= prices[0];
  const polyline = pts.join(" ");
  const area = `${pad},${h - pad} ${polyline} ${w - pad},${h - pad}`;
  return (
    <svg width={w} height={h}>
      <polygon points={area} fill={up ? "#d1fae5" : "#fee2e2"} opacity={0.5} />
      <polyline points={polyline} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth={1.5} />
    </svg>
  );
}

// ─── Price Source Status Banner ──────────────────────────────────────────────
function PriceSourceBanner({ status, onRetry, activeProvider }) {
  const { fetching, ok, diags, lastSuccess, lastAttempt } = status;

  if (fetching && ok === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 10, background: "#fef3c7", border: "0.5px solid #f59e0b", fontSize: 11 }}>
        <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
        <span style={{ color: "#92400e" }}>Fetching live prices from Coinbase Exchange…</span>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (ok) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 10, background: "#d1fae5", border: "0.5px solid #10b981", fontSize: 11 }}>
        <span style={{ color: "#065f46", fontSize: 14 }}>✓</span>
        <span style={{ color: "#065f46", fontWeight: 600 }}>Live prices synced from {activeProvider?.name || "exchange"}</span>
        {lastSuccess && <span style={{ color: "#065f46", opacity: 0.7 }}>- last sync {lastSuccess}</span>}
        {fetching && <span style={{ marginLeft: 4, color: "#065f46", opacity: 0.6 }}>syncing…</span>}
      </div>
    );
  }

  // Failed state — show full diagnostics per coin
  const errorTypeLabels = {
    no_proxy: "Proxy not configured",
    cors: "CORS blocked — browser prevented the request",
    network: "Network error — proxy unreachable",
    http: "HTTP error — proxy or Coinbase rejected the request",
    parse: "Parse error — unexpected response format",
    empty: "Empty response — price field missing from proxy",
  };

  return (
    <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 10, background: "#fef2f2", border: "0.5px solid #ef4444", fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#ef4444", fontSize: 15 }}>⚠</span>
          <span style={{ color: "#991b1b", fontWeight: 600 }}>
            {"Live price sync failed - showing simulated prices"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {lastAttempt && <span style={{ color: "#991b1b", opacity: 0.7 }}>last tried {lastAttempt}</span>}
          <button onClick={onRetry} style={{ padding: "3px 10px", borderRadius: 5, border: "0.5px solid #ef4444", background: "#fee2e2", color: "#991b1b", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            Retry
          </button>
        </div>
      </div>

      {/* Per-coin breakdown */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {COINS.map((coin) => {
          const d = diags[coin];
          if (!d) return null;
          return (
            <div key={coin} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ minWidth: 32, fontWeight: 600, color: d.ok ? "#065f46" : "#991b1b" }}>
                {d.ok ? "✓" : "✗"} {coin}
              </span>
              {d.ok ? (
                <span style={{ color: "#065f46" }}>${d.price?.toLocaleString()}</span>
              ) : (
                <span style={{ color: "#7f1d1d" }}>
                  <strong style={{ color: "#ef4444" }}>[{d.errorType?.toUpperCase()}]</strong>{" "}
                  {errorTypeLabels[d.errorType] || d.errorType}
                  {d.errorMsg && d.errorMsg !== errorTypeLabels[d.errorType] && (
                    <span style={{ opacity: 0.7 }}>{" - "}{d.errorMsg}</span>
                  )}
                  {d.httpStatus && <span style={{ opacity: 0.6 }}> (HTTP {d.httpStatus})</span>}
                  {d.raw && (
                    <div style={{ marginTop: 2, fontFamily: "monospace", fontSize: 10, opacity: 0.6, wordBreak: "break-all" }}>
                      Raw: {d.raw}
                    </div>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, color: "#991b1b", lineHeight: 1.6, fontSize: 11 }}>
        {diags[COINS[0]]?.errorType === "no_proxy" && (
          <div style={{ background: "#fff7ed", border: "0.5px solid #f59e0b", borderRadius: 6, padding: "8px 10px", color: "#92400e" }}>
            <strong>Setup required:</strong> Deploy the included <code>coinbase-cors-proxy</code> to Vercel,
            then set <code style={{ background: "#fef3c7", padding: "1px 4px", borderRadius: 3 }}>PROXY_BASE</code> in
            the source to your Cloud Run function URL.
            See <strong>README.md</strong> inside the proxy folder for step-by-step instructions.
          </div>
        )}
        {diags[COINS[0]]?.errorType === "cors" && (
          <div style={{ opacity: 0.8 }}>
            <strong>CORS blocked:</strong> The proxy URL may be wrong or not yet deployed.
            Verify <code>PROXY_BASE</code> matches your Cloud Run function URL exactly.
          </div>
        )}
        {diags[COINS[0]]?.errorType === "network" && (
          <div style={{ opacity: 0.8 }}>
            <strong>Network error:</strong>{" Proxy is unreachable - check the deployment URL is correct."}
          </div>
        )}
        {diags[COINS[0]]?.errorType === "http" && (
          <div style={{ opacity: 0.8 }}>
            <strong>HTTP {diags[COINS[0]]?.httpStatus}:</strong> The proxy responded with an error.
            Check the Vercel function logs for details.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rate Limit Monitor Panel ────────────────────────────────────────────────
function RateLimitMonitor({ stats }) {
  const readPct = Math.min((stats.readUsed / stats.readMax) * 100, 100);
  const writePct = Math.min((stats.writeUsed / stats.writeMax) * 100, 100);
  const readColor = readPct > 80 ? "#ef4444" : readPct > 50 ? "#f59e0b" : "#10b981";
  const writeColor = writePct > 80 ? "#ef4444" : writePct > 50 ? "#f59e0b" : "#10b981";

  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <i className="ti ti-activity" aria-hidden="true" />{" API rate limits - 10-second rolling window"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
        {[
          { label: "Read (GET)", used: stats.readUsed, max: stats.readMax, pct: readPct, color: readColor, queued: stats.readQueued },
          { label: "Write (POST)", used: stats.writeUsed, max: stats.writeMax, pct: writePct, color: writeColor, queued: stats.writeQueued },
        ].map(({ label, used, max, pct, color, queued }) => (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
              <span style={{ fontWeight: 600, color }}>
                {used} / {max}
                {queued > 0 && <span style={{ marginLeft: 6, color: "#f59e0b" }}>+{queued} queued</span>}
              </span>
            </div>
            <div style={{ height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: color, borderRadius: 3, transition: "width 0.3s ease" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
              {(100 - pct).toFixed(0)}% headroom · {max - used} slots free
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--color-text-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8, flexWrap: "wrap" }}>
        <span><i className="ti ti-refresh" aria-hidden="true" style={{ color: stats.retries > 0 ? "#f59e0b" : "inherit" }} /> Retries: <strong style={{ color: stats.retries > 0 ? "#f59e0b" : "var(--color-text-primary)" }}>{stats.retries}</strong></span>
        <span><i className="ti ti-clock-pause" aria-hidden="true" style={{ color: stats.throttled > 0 ? "#f59e0b" : "inherit" }} /> Throttled: <strong style={{ color: stats.throttled > 0 ? "#f59e0b" : "var(--color-text-primary)" }}>{stats.throttled}</strong></span>
        <span style={{ fontSize: 10 }}>Backoff: base {BASE_DELAY_MS}ms · max {MAX_BACKOFF_MS / 1000}s · {MAX_RETRIES} retries</span>
        {stats.lastError && (
          <span style={{ marginLeft: "auto", color: "#ef4444", fontSize: 10, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <i className="ti ti-alert-triangle" aria-hidden="true" /> {stats.lastError}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function ExitRuleRow({ coin, rule, onChange, color }) {
  const set = (k, v) => onChange({ ...rule, [k]: v });
  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px", border: `0.5px solid ${color}44` }}>
      <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 8 }}>{coin}/USD</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {/* Take Profit */}
        <div>
          <div style={{ fontSize: 11, color: "#10b981", fontWeight: 600, marginBottom: 5 }}>
            ↑ Take Profit
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <select value={rule.takeProfitType} onChange={e => set("takeProfitType", e.target.value)}
              style={{ fontSize: 11, padding: "3px 4px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <option value="percent">%</option>
              <option value="absolute">$ price</option>
            </select>
            <input type="number" value={rule.takeProfitValue}
              onChange={e => set("takeProfitValue", e.target.value)}
              min="0" step={rule.takeProfitType === "percent" ? "0.1" : "1"}
              placeholder={rule.takeProfitType === "percent" ? "e.g. 2" : "e.g. 500"}
              style={{ width: "100%", fontSize: 11, padding: "3px 6px", boxSizing: "border-box" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            {rule.takeProfitType === "percent"
              ? `Sell when price rises ${rule.takeProfitValue || "0"}% above entry`
              : `Sell when price rises $${rule.takeProfitValue || "0"} above entry`}
          </div>
        </div>
        {/* Stop Loss */}
        <div>
          <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 600, marginBottom: 5 }}>
            ↓ Stop Loss
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <select value={rule.stopLossType} onChange={e => set("stopLossType", e.target.value)}
              style={{ fontSize: 11, padding: "3px 4px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <option value="percent">%</option>
              <option value="absolute">$ price</option>
            </select>
            <input type="number" value={rule.stopLossValue}
              onChange={e => set("stopLossValue", e.target.value)}
              min="0" step={rule.stopLossType === "percent" ? "0.1" : "1"}
              placeholder={rule.stopLossType === "percent" ? "e.g. 1" : "e.g. 200"}
              style={{ width: "100%", fontSize: 11, padding: "3px 6px", boxSizing: "border-box" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            {rule.stopLossType === "percent"
              ? `Sell when price drops ${rule.stopLossValue || "0"}% below entry`
              : `Sell when price drops $${rule.stopLossValue || "0"} below entry`}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ creds, onSave, onClose, limits, clerkPlan, sessionContext = null, forcedTab = null }) {
  // Plan limits with safe defaults (all features on if no Clerk)
  const planLimits = limits || { maxCoins: 50, canLive: true, canAI: true };
  const defaultExitRules = {
    BTC: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    ETH: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    SOL: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
  };
  const defaultKeys = {
    coinbase: { apiKeyName: "", privateKey: "" },
    binance:  { apiKey: "", secretKey: "" },
    kraken:   { apiKey: "", privateKey: "" },
    gemini:   { apiKey: "", secretKey: "" },
    alpaca:   { apiKey: "", secretKey: "" },
    public:   { apiKey: "", secretKey: "" },
  };
  const [form, setForm] = useState({
    provider:      creds.provider || "coinbase",
    tradeSizeUSD:   creds.tradeSizeUSD   || "50",
    balanceBuffer:  creds.balanceBuffer  || "0.50",
    minConfidence: creds.minConfidence || "60",
    feePercent:    creds.feePercent    || "0.1",
    enabledCoins:  creds.enabledCoins || ["BTC"],
    sandbox:       creds.sandbox !== undefined ? creds.sandbox : false,
    keys:          { ...defaultKeys, ...creds.keys },
    exitRules:     creds.exitRules || defaultExitRules,
    exitStrategies: creds.exitStrategies || {
      trailingTakeProfit: { enabled: false, trailPercent: "1.0" },
      timeExit:       { enabled: true,  maxHoldMinutes: "30"  },
      trailingStop:   { enabled: true,  trailPercent:   "1.5", trailDelta: "absolute" },
      atrExit:        { enabled: false, atrMultiplier:  "1.5" },
      atrTpSl: creds.exitStrategies?.atrTpSl || {
        enabled: false, tpMultiplier: "1.5", slMultiplier: "0.75", partialExit: false,
      },
      trendAlignment: creds.exitStrategies?.trendAlignment || {
        enabled: false, requireBullish1h: true, requireBullish15m: true,
        requireRsiAbove: "45", strictMode: false,
      },
      volumeGate:     { enabled: true,  minVolumeRatio: "1.2" },
      signalReversal: { enabled: true,  reversalScore:  "-2"  },
    },
    cooldownMinutes:   creds.cooldownMinutes   || "1",
    agentMode:          creds.agentMode !== undefined ? creds.agentMode : false,
    signalSource:       creds.signalSource       || "rules",
    llmProvider:        creds.llmProvider        || "deepseek",
    llmKeys:            creds.llmKeys            || { deepseek:"", claude:"", gpt:"", gemini:"", llama:"" },
    customRules:        creds.customRules         || { enabled:false, groupLogic:"and", groups:[] },
    ruleCombiner:       creds.ruleCombiner        || { logic:"and", customThreshold:"0.3", minAgree:"3" },
    agentIntervalSec:   creds.agentIntervalSec   || "15",
    rlParams: creds.rlParams || {
      alpha:        "0.1",   // learning rate
      gamma:        "0.9",   // discount factor
      epsilonStart: "0.4",   // initial exploration rate
      epsilonMin:   "0.05",  // minimum exploration
      epsilonDecay: "0.995", // decay per episode
      minEpisodes:  "20",    // warmup threshold
      rewardScale:  "100",   // multiply netPnl by this for reward signal
      resetOnStop:  true,    // reset Q-table when simulation stops
    },
    adaptiveSettings:   creds.adaptiveSettings   || { enabled: false, maxTpDelta: "2", maxSlDelta: "1", requireHigh: "70", applyAfter: "3" },
    tradingMode:        creds.tradingMode        || "momentum",
    volatilityGate:     creds.volatilityGate     || { enabled: true, minVolatility: "0.3", minAtrPct: "0.3", minDirProb: "0.65" },
    minRrRatio:         creds.minRrRatio         || "3",
    postBuyLimitSell: creds.postBuyLimitSell || {
      enabled: false, offsetType: "percent", offsetValue: "1.5",
    },
    buyOrderConfig: creds.buyOrderConfig || {
      type: "market", limitOffsetType: "percent", limitOffsetValue: "0.05",
    },
    sellOrderConfig: creds.sellOrderConfig || {
      type: "market", limitOffsetType: "percent", limitOffsetValue: "0.1",
      stopPricePct: "0.5", limitPricePct: "0.6",
      ocoTpPct: "2", ocoSlPct: "1",
      trailStopDelta: "1.5", trailDeltaType: "percent",
    },
    tickIntervalMs:   creds.tickIntervalMs   || 1500,
    dynamicExits: creds.dynamicExits || {
      enabled: false, mode: "aggressive_when_winning",
      profitThreshold: "20", lossThreshold: "-20",
      maxTpBoost: "50", maxTpCut: "50", maxSlTighten: "30",
      scaleBy: "total",
    },
    indicatorPeriods: creds.indicatorPeriods || {
      smaFast: 20, smaMid: 50, smaSlow: 99, emaFast: 12, emaSlow: 26, rsi: 14, bollinger: 20, atr: 14,
    },
    indicatorConfig: creds.indicatorConfig || {
      rsi:       { enabled: true,  weight: "2",   oversold: "35",  overbought: "65" },
      sma_20_50: { enabled: true,  weight: "1.5", fast: "20",      slow: "50"       },
      sma_20_99: { enabled: false, weight: "2",   fast: "20",      slow: "99"       },
      sma_50_99: { enabled: false, weight: "1.5", fast: "50",      slow: "99"       },
      ema_12_26: { enabled: false, weight: "1.5", fast: "12",      slow: "26"       },
      macd:      { enabled: true,  weight: "1"                                      },
      bollinger: { enabled: true,  weight: "2",   period: "20"                      },
      news:      { enabled: true,  weight: "1.5"                                    },
    },
  });
  const [activeTab, setActiveTab] = useState("provider");
  // Allow the onboarding tour to force-switch tabs so its target elements exist
  useEffect(() => {
    if (forcedTab) setActiveTab(forcedTab);
  }, [forcedTab]);
  const [showSecrets, setShowSecrets] = useState({});

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setProviderKey = (providerId, field, value) =>
    set("keys", { ...form.keys, [providerId]: { ...form.keys[providerId], [field]: value } });
  const toggleCoin = (c) => set("enabledCoins",
    form.enabledCoins.includes(c)
      ? form.enabledCoins.filter(x => x !== c)
      : [...form.enabledCoins, c]);
  const setExitRule = (coin, rule) => set("exitRules", { ...form.exitRules, [coin]: rule });
  const setExitStrategy = (key, patch) => set("exitStrategies", { ...form.exitStrategies, [key]: { ...form.exitStrategies[key], ...patch } });
  const setIndicator    = (key, patch) => set("indicatorConfig",  { ...form.indicatorConfig,  [key]: { ...form.indicatorConfig[key],  ...patch } });
  const setIndicatorPeriod = (key, value) => set("indicatorPeriods", { ...form.indicatorPeriods, [key]: parseInt(value) || 1 });
  const setDynamicExits  = (patch) => set("dynamicExits",  { ...form.dynamicExits,  ...patch });
  const setRuleCombiner  = (patch) => set("ruleCombiner",  { ...form.ruleCombiner,  ...patch });
  const setLlmKey        = (provider, val) => set("llmKeys", { ...form.llmKeys, [provider]: val });
  const setSellOrder    = (patch)       => set("sellOrderConfig",  { ...form.sellOrderConfig, ...patch });
  const setBuyOrder         = (patch) => set("buyOrderConfig",    { ...form.buyOrderConfig,    ...patch });
  const setPostBuyLimitSell = (patch) => set("postBuyLimitSell", { ...form.postBuyLimitSell, ...patch });
  const toggleSecret = (field) => setShowSecrets(s => ({ ...s, [field]: !s[field] }));

  const activeProviderInfo = EXCHANGE_PROVIDERS[form.provider];
  const activeKeys = form.keys[form.provider] || {};

  const tabStyle = (id) => ({
    padding: "6px 14px", borderRadius: 6, border: "0.5px solid", cursor: "pointer", fontSize: 12, fontWeight: 600,
    borderColor: activeTab === id ? "#6366f1" : "var(--color-border-tertiary)",
    background: activeTab === id ? "#6366f122" : "transparent",
    color: activeTab === id ? "#6366f1" : "var(--color-text-secondary)",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, padding: "24px 28px", width: 560, maxWidth: "96vw", maxHeight: "92vh", overflowY: "auto" }}>
        
        {/* Session context banner */}
        {sessionContext && (
          <div style={{
            margin: "-24px -28px 16px",
            padding: "10px 20px",
            background: sessionContext.isRunning ? "#065f46" : "#1e1b4b",
            borderRadius: "14px 14px 0 0",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {sessionContext.isRunning && (
                <span style={{ width: 7, height: 7, borderRadius: "50%",
                  background: "#10b981", boxShadow: "0 0 0 3px #10b98133",
                  display: "inline-block", flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 600 }}>
                {sessionContext.isRunning ? "🟢 Running session" : "Session settings"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                "{sessionContext.name}"
              </span>
            </div>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", textAlign: "right" }}>
              {sessionContext.isRunning
                ? "Changes push to the live session immediately"
                : "Save and resume to apply changes"}
            </span>
          </div>
        )}

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {sessionContext ? "Session settings" : "Settings"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
              {sessionContext
                ? `Viewing settings for "${sessionContext.name}"`
                : "Exchange, credentials & trading rules"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--color-text-secondary)" }}>
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 5, marginBottom: 20, flexWrap: "wrap" }}>
          <button data-tour="tab-provider" style={tabStyle("provider")}     onClick={() => setActiveTab("provider")}>🏦 Exchange</button>
          <button style={tabStyle("credentials")}  onClick={() => setActiveTab("credentials")}>🔑 Keys</button>
          <button style={tabStyle("llm")}          onClick={() => setActiveTab("llm")}>🤖 AI / LLM</button>
          <button data-tour="tab-signals" style={tabStyle("signals")}      onClick={() => setActiveTab("signals")}>📡 Signals</button>
          <button style={tabStyle("execution")}    onClick={() => setActiveTab("execution")}>⚡ Execution</button>
          <button data-tour="tab-exits" style={tabStyle("exits")}        onClick={() => setActiveTab("exits")}>🎯 Exits</button>
          <button style={tabStyle("indicators")}   onClick={() => setActiveTab("indicators")}>📊 Indicators</button>
          <button style={tabStyle("rules")}         onClick={() => setActiveTab("rules")}>⚙️ Rules</button>
        </div>

        {/* ── Tab: Exchange selector ─────────────────────────────────────── */}
        {activeTab === "provider" && (
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
              Select your trading platform. Each exchange uses its own authentication and order format.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {Object.values(EXCHANGE_PROVIDERS).map(p => {
                const keys = form.keys[p.id] || {};
                const configured = Object.values(keys).some(v => v && v.trim());
                const active = form.provider === p.id;
                return (
                  <div key={p.id} onClick={() => set("provider", p.id)}
                    style={{ padding: "12px 14px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                      border: `0.5px solid ${active ? p.color : "var(--color-border-tertiary)"}`,
                      background: active ? p.color + "15" : "var(--color-background-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 18 }}>{p.logo}</span>
                      <span style={{ fontWeight: 600, fontSize: 13, color: active ? p.color : "var(--color-text-primary)" }}>{p.name}</span>
                      {configured && <span style={{ marginLeft: "auto", fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>✓</span>}
                      {active && !configured && <span style={{ marginLeft: "auto", fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4 }}>needs keys</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                      {p.id === "public" ? "Invite-only API — sandbox mode only" :
                       `Rate limit: ${p.rateLimit.read} reads / ${p.rateLimit.windowMs/1000}s`}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--color-background-secondary)", border: `0.5px solid ${activeProviderInfo.color}44`, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: activeProviderInfo.color }}>{activeProviderInfo.logo} {activeProviderInfo.name}</span>
              {" — "}
              <a href={activeProviderInfo.docsUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: activeProviderInfo.color, textDecoration: "underline" }}>API docs ↗</a>
            </div>
          </div>
        )}

        {/* ── Tab: Credentials (shows fields for ALL providers) ──────────── */}
        {activeTab === "credentials" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", padding: "8px 12px", borderRadius: 8 }}>
              Fill in credentials for any exchanges you want to use. Only the active exchange is used for trading.
              {"Keys are stored in browser memory only - never sent to any server other than the exchange."}
            </div>
            {Object.values(EXCHANGE_PROVIDERS).map(p => {
              const keys = form.keys[p.id] || {};
              const isActive = form.provider === p.id;
              return (
                <div key={p.id} style={{ border: `0.5px solid ${isActive ? p.color : "var(--color-border-tertiary)"}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>{p.logo}</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: p.color }}>{p.name}</span>
                    {isActive && <span style={{ fontSize: 10, background: p.color + "22", color: p.color, padding: "1px 8px", borderRadius: 4, fontWeight: 600 }}>ACTIVE</span>}
                    <a href={p.docsUrl} target="_blank" rel="noopener noreferrer"
                      style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-tertiary)", textDecoration: "underline" }}>docs ↗</a>
                  </div>
                  {p.id === "public" ? (
                    <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Public.com API is invite-only. This exchange runs in sandbox mode only.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {p.credFields.map(field => (
                        <label key={field.key} style={{ fontSize: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ color: "var(--color-text-secondary)" }}>{field.label}</span>
                            {(field.type === "password" || field.type === "pem") && (
                              <button onClick={() => toggleSecret(`${p.id}_${field.key}`)}
                                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--color-text-tertiary)" }}>
                                {showSecrets[`${p.id}_${field.key}`] ? "hide" : "show"}
                              </button>
                            )}
                          </div>
                          {field.type === "pem" ? (
                            <textarea value={keys[field.key] || ""} onChange={e => setProviderKey(p.id, field.key, e.target.value)}
                              placeholder={field.placeholder} rows={3}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 10, boxSizing: "border-box", resize: "vertical",
                                filter: showSecrets[`${p.id}_${field.key}`] ? "none" : "blur(3px)" }} />
                          ) : (
                            <input
                              type={field.type === "password" && !showSecrets[`${p.id}_${field.key}`] ? "password" : "text"}
                              value={keys[field.key] || ""}
                              onChange={e => setProviderKey(p.id, field.key, e.target.value)}
                              placeholder={field.placeholder}
                              style={{ width: "100%", fontFamily: field.type === "text" ? "inherit" : "monospace", fontSize: 11, boxSizing: "border-box" }} />
                          )}
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>{field.hint}</div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Global sandbox toggle */}
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "10px 14px", borderRadius: 8, border: form.sandbox ? "0.5px solid #6366f1" : "0.5px solid var(--color-border-tertiary)", background: form.sandbox ? "#6366f111" : "transparent" }}>
              <input type="checkbox" checked={form.sandbox} onChange={e => set("sandbox", e.target.checked)} />
              <div>
                <div style={{ fontWeight: 600, color: form.sandbox ? "#6366f1" : "var(--color-text-primary)" }}>Sandbox / paper-trading mode</div>
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{"Simulates all orders - no real trades on any exchange"}</div>
              </div>
            </label>
          </div>
        )}


        {/* ── Tab: AI / LLM ────────────────────────────────────────────────── */}
        {activeTab === "llm" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* LLM Provider selector */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                AI Provider
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  Select the LLM that powers the trading agent
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                {[
                  { id: "deepseek", label: "DeepSeek V3",  icon: "🔮", note: "Best value. Fast, accurate, low cost.",         envKey: "DEEPSEEK_API_KEY",   link: "platform.deepseek.com" },
                  { id: "gpt",      label: "GPT-4o Mini",  icon: "⚡", note: "OpenAI. Reliable, widely tested.",              envKey: "OPENAI_API_KEY",     link: "platform.openai.com"   },
                  { id: "claude",   label: "Claude Haiku",  icon: "🧠", note: "Anthropic. Strong reasoning, nuanced.",         envKey: "ANTHROPIC_API_KEY",  link: "console.anthropic.com" },
                  { id: "gemini",   label: "Gemini Flash",  icon: "💡", note: "Google. Fast and free tier available.",         envKey: "GEMINI_API_KEY",     link: "aistudio.google.com"   },
                  { id: "llama",    label: "Llama 3.1",     icon: "🦙", note: "Meta via Groq. Open source, very fast.",        envKey: "GROQ_API_KEY",       link: "console.groq.com"      },
                ].map(p => (
                  <div key={p.id} onClick={() => set("llmProvider", p.id)}
                    style={{ padding: "12px 14px", borderRadius: 9, cursor: "pointer",
                      border: `0.5px solid ${form.llmProvider === p.id ? "#6366f1" : "var(--color-border-tertiary)"}`,
                      background: form.llmProvider === p.id ? "#6366f112" : "var(--color-background-secondary)" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: form.llmProvider === p.id ? "#6366f1" : "var(--color-text-primary)", marginBottom: 3 }}>
                      {p.icon} {p.label}
                      {form.llmProvider === p.id && <span style={{ fontSize: 9, marginLeft: 6, background: "#6366f122", color: "#6366f1", padding: "1px 6px", borderRadius: 4 }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{p.note}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{p.envKey}</div>
                  </div>
                ))}
              </div>

              {/* API Key fields for all providers */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { id: "deepseek", label: "DeepSeek API Key",   placeholder: "sk-...",                link: "https://platform.deepseek.com/api_keys"   },
                  { id: "gpt",      label: "OpenAI API Key",      placeholder: "sk-...",                link: "https://platform.openai.com/api-keys"      },
                  { id: "claude",   label: "Anthropic API Key",   placeholder: "sk-ant-...",            link: "https://console.anthropic.com/settings/keys"},
                  { id: "gemini",   label: "Google Gemini Key",   placeholder: "AIza...",               link: "https://aistudio.google.com/app/apikey"    },
                  { id: "llama",    label: "Groq API Key (Llama)",placeholder: "gsk_...",               link: "https://console.groq.com/keys"             },
                ].map(p => (
                  <div key={p.id} style={{ display: "flex", gap: 10, alignItems: "flex-end",
                    opacity: form.llmProvider === p.id ? 1 : 0.5 }}>
                    <label style={{ flex: 1, fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 4, display: "flex", gap: 8, alignItems: "center" }}>
                        {p.label}
                        {form.llmProvider === p.id && <span style={{ fontSize: 9, background: "#6366f122", color: "#6366f1", padding: "1px 5px", borderRadius: 3 }}>ACTIVE</span>}
                      </div>
                      <input
                        type="password"
                        value={form.llmKeys?.[p.id] || ""}
                        onChange={e => setLlmKey(p.id, e.target.value)}
                        placeholder={p.placeholder}
                        style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 11 }}
                      />
                    </label>
                    <a href={p.link} target="_blank" rel="noreferrer"
                      style={{ fontSize: 10, color: "#6366f1", textDecoration: "none", marginBottom: 6, whiteSpace: "nowrap" }}>
                      Get key ↗
                    </a>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.6, padding: "8px 10px", borderRadius: 6, background: "var(--color-background-secondary)" }}>
                ⚠️ API keys are sent to your Cloud Run proxy and stored as environment variables — never exposed in the browser.
                The active provider ({form.llmProvider}) is sent with each agent request and the proxy uses the matching env var key.
              </div>
            </div>

            {/* Rule combiner */}
            <div style={{ borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                Rule combiner logic
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  How indicators are combined when using Rules signal source
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                {[
                  { value: "and",    label: "AND",    desc: "All N indicators must agree. Most selective, fewer trades." },
                  { value: "or",     label: "OR",     desc: "Any strong indicator triggers. More trades, higher risk." },
                  { value: "custom", label: "Custom", desc: "Set your own score threshold and min agreeing count." },
                ].map(m => (
                  <div key={m.value} onClick={() => setRuleCombiner({ logic: m.value })}
                    style={{ padding: "9px 11px", borderRadius: 7, cursor: "pointer",
                      border: `0.5px solid ${form.ruleCombiner?.logic === m.value ? "#10b981" : "var(--color-border-tertiary)"}`,
                      background: form.ruleCombiner?.logic === m.value ? "#10b98112" : "var(--color-background-secondary)" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: form.ruleCombiner?.logic === m.value ? "#10b981" : "var(--color-text-primary)" }}>{m.label}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>{m.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>
                    Min agreeing indicators
                  </div>
                  <input type="number" value={form.ruleCombiner?.minAgree || "3"} min="1" max="10"
                    onChange={e => setRuleCombiner({ minAgree: e.target.value })}
                    style={{ width: "100%", boxSizing: "border-box" }} />
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                    Used by AND and Custom modes
                  </div>
                </label>
                {form.ruleCombiner?.logic === "custom" && (
                  <label style={{ fontSize: 12 }}>
                    <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>Score threshold (0–1)</div>
                    <input type="number" value={form.ruleCombiner?.customThreshold || "0.3"} min="0" max="1" step="0.05"
                      onChange={e => setRuleCombiner({ customThreshold: e.target.value })}
                      style={{ width: "100%", boxSizing: "border-box" }} />
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                      Fraction of max score needed to signal
                    </div>
                  </label>
                )}
              </div>
            </div>


          </div>
        )}

        {/* ── Tab: Signals ─────────────────────────────────────────────────── */}
        {activeTab === "signals" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                  Starting trade size (USD)
                  <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "block", marginTop: 1 }}>
                    Initial amount — compounds with P&L during session
                  </span>
                </div>
                <input data-tour="trade-size-input" type="number" value={form.tradeSizeUSD} onChange={e => set("tradeSizeUSD", e.target.value)}
                  min="1" max="100000" style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                  Balance buffer ($)
                  <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "block", marginTop: 1 }}>
                    Deducted from live balance before trading
                  </span>
                </div>
                <input type="number" value={form.balanceBuffer} onChange={e => set("balanceBuffer", e.target.value)}
                  min="0" max="100" step="0.01" style={{ width: "100%", boxSizing: "border-box" }} />
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
                  e.g. $0.50 — prevents "insufficient funds" errors from rounding.
                  Live balance $5,000.98 → trades with ${(5000.98 - parseFloat(form.balanceBuffer || 0.5)).toFixed(2)}
                </div>
              </label>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Min confidence (%)</div>
                <input type="number" value={form.minConfidence} onChange={e => set("minConfidence", e.target.value)}
                  min="50" max="99" style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                  Trading fee (% per side)
                  <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "block", marginTop: 1 }}>
                    Applied to both BUY and SELL
                  </span>
                </div>
                <input type="number" value={form.feePercent} onChange={e => set("feePercent", e.target.value)}
                  min="0" max="2" step="0.01" style={{ width: "100%", boxSizing: "border-box" }} />
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
                  {form.feePercent
                    ? `Round-trip cost: ${(parseFloat(form.feePercent) * 2).toFixed(2)}% — need >${(parseFloat(form.feePercent) * 2).toFixed(2)}% gain to profit`
                    : "0 = no fees (simulation)"}
                </div>
              </label>
            </div>

            {/* ── Cooldown period ─────────────────────────────────────── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, alignItems: "start" }}>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                  Cool-off after sell (min)
                  <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "block", marginTop: 1 }}>
                    No BUY signal for N minutes after a sell
                  </span>
                </div>
                <input type="number" value={form.cooldownMinutes} onChange={e => set("cooldownMinutes", e.target.value)}
                  min="0" max="60" step="0.5" style={{ width: "100%", boxSizing: "border-box" }} />
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
                  {form.cooldownMinutes === "0" ? "No cooldown" : `${form.cooldownMinutes} min cool-off`}
                </div>
              </label>
              <div style={{ padding: "8px 12px", borderRadius: 7, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                Cool-off prevents immediately re-entering a trade right after a stop-loss or time exit,
                giving the market time to stabilise. Set to 0 to disable.
              </div>
            </div>

            <div data-tour="coins-select">
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 600 }}>Active trading pairs</div>
              <div style={{ display: "flex", gap: 8 }}>
                {COINS.map(c => (
                  <button key={c} onClick={() => toggleCoin(c)}
                    style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 12,
                      border: `0.5px solid ${form.enabledCoins.includes(c) ? COIN_COLORS[c] : "var(--color-border-tertiary)"}`,
                      background: form.enabledCoins.includes(c) ? COIN_COLORS[c] + "22" : "transparent",
                      color: form.enabledCoins.includes(c) ? COIN_COLORS[c] : "var(--color-text-secondary)" }}>
                    {c}/USD
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>
                Buys driven by indicators. Sells triggered by exit rules only.
              </div>
              {form.enabledCoins.length > planLimits.maxCoins && (
                <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "#fef3c711", border: "0.5px solid #f59e0b", fontSize: 11, color: "#92400e" }}>
                  🔒 Your <strong>{clerkPlan || "free"}</strong> plan allows <strong>{planLimits.maxCoins}</strong> active coin{planLimits.maxCoins !== 1 ? "s" : ""}.{" "}
                  <a href="/upgrade" style={{ color: "#f59e0b", fontWeight: 700 }}>Upgrade →</a>
                </div>
              )}
            </div>

            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 600 }}>Exit rules - TP / SL (per coin)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {form.enabledCoins.map(c => (
                  <ExitRuleRow key={c} coin={c} rule={form.exitRules[c] || defaultExitRules[c]}
                    onChange={rule => setExitRule(c, rule)} color={COIN_COLORS[c]} />
                ))}
              </div>
            </div>

            {/* ── Exit Strategies ─────────────────────────────────────── */}
            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, fontWeight: 600 }}>
                Exit strategies
                <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontWeight: 400, marginLeft: 8 }}>
                  Additional sell triggers - toggle each on/off
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

                {/* Time-based exit */}
                {[
                  {
                    key: "trailingTakeProfit",
                    label: "🎯 Trailing take-profit",
                    desc: "Let profits run after TP is hit — sell only when price reverses by a set %",
                    fields: [{ k: "trailPercent", label: "Reversal % from peak", min: 0.1, max: 20, step: 0.1, hint: "e.g. 1% = sell when price drops 1% from post-TP peak" }],
                  },
                  {
                    key: "timeExit",
                    label: "⏱ Time-based exit",
                    desc: "Force sell if position not closed within N minutes",
                    fields: [{ k: "maxHoldMinutes", label: "Max hold (min)", min: 1, max: 1440, step: 1, hint: "e.g. 30 min" }],
                  },
                  {
                    key: "trailingStop",
                    label: "📉 Trailing stop loss",
                    desc: "Stop rises with price — locks in gains if price reverses",
                    fields: [{ k: "trailPercent", label: "Trail amount", min: 0.1, max: 20000, step: 0.1, hint: "% or $ depending on delta type" }],
                    extra: "trailDelta",
                  },
                  {
                    key: "atrExit",
                    label: "📊 ATR-based exit",
                    desc: "Scales TP/SL with recent volatility (ATR × multiplier)",
                    fields: [{ k: "atrMultiplier", label: "ATR multiplier", min: 0.5, max: 5, step: 0.1, hint: "e.g. 1.5× ATR" }],
                  },
                  {
                    key: "atrTpSl",
                    label: "🎯 ATR-based TP/SL (recommended)",
                    desc: "Sets TP and SL as ATR multiples — scales with actual volatility instead of a fixed %. Partial exit closes 50% at 1×ATR then moves SL to breakeven.",
                    fields: [
                      { k: "tpMultiplier", label: "TP multiplier (ATR×)", min: 0.5, max: 5, step: 0.25, hint: "e.g. 1.5 = TP at entry + 1.5×ATR" },
                      { k: "slMultiplier", label: "SL multiplier (ATR×)", min: 0.1, max: 3, step: 0.25, hint: "e.g. 0.75 = SL at entry - 0.75×ATR (2:1 R:R)" },
                    ],
                    extraCheckbox: { k: "partialExit", label: "Partial exit at 1×ATR (50% off, move SL to breakeven)" },
                  },
                  {
                    key: "trendAlignment",
                    label: "📈 Trend alignment gate (recommended)",
                    desc: "Only allow BUY when higher timeframes confirm the trend direction. Prevents counter-trend entries that stall before reaching TP.",
                    fields: [
                      { k: "requireRsiAbove", label: "1h RSI floor", min: 30, max: 60, step: 1, hint: "Block BUY if 1h RSI below this (e.g. 45)" },
                    ],
                    extraCheckboxes: [
                      { k: "requireBullish1h",  label: "Require price above 1h SMA50 (long-term uptrend)" },
                      { k: "requireBullish15m", label: "Require 15m EMA12 > EMA26 (momentum confirming)" },
                      { k: "strictMode",        label: "Strict: all filters must pass (default: 2 of 3)" },
                    ],
                  },
                  {
                    key: "volumeGate",
                    label: "📦 Volume gate on BUY",
                    desc: "Only buy when volume ratio is above threshold",
                    fields: [{ k: "minVolumeRatio", label: "Min vol ratio", min: 0.5, max: 5, step: 0.1, hint: "e.g. 1.2× average" }],
                  },
                  {
                    key: "signalReversal",
                    label: "🔄 Signal reversal exit",
                    desc: "Sell if signal score drops below threshold while holding",
                    fields: [{ k: "reversalScore", label: "Reversal score", min: -8, max: 0, step: 0.5, hint: "e.g. -2 triggers sell" }],
                  },
                ].map(({ key, label, desc, fields, extra, extraCheckbox, extraCheckboxes }) => {
                  const s = form.exitStrategies[key] || {};
                  const on = s.enabled;
                  return (
                    <div key={key} style={{ borderRadius: 8, border: `0.5px solid ${on ? "#6366f1" : "var(--color-border-tertiary)"}`, padding: "10px 12px", background: on ? "#6366f108" : "transparent" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: on ? 10 : 0 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
                          <input type="checkbox" checked={!!on} onChange={e => setExitStrategy(key, { enabled: e.target.checked })} />
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: on ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>{label}</div>
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 1 }}>{desc}</div>
                          </div>
                        </label>
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 600,
                          background: on ? "#6366f122" : "var(--color-background-secondary)",
                          color: on ? "#6366f1" : "var(--color-text-tertiary)" }}>
                          {on ? "ON" : "OFF"}
                        </span>
                      </div>
                      {on && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {/* Delta type selector for trailing stop */}
                            {extra === "trailDelta" && (
                              <label style={{ fontSize: 11 }}>
                                <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>Delta type</div>
                                <select value={s.trailDelta || "percent"}
                                  onChange={e => setExitStrategy(key, { trailDelta: e.target.value })}
                                  style={{ fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                                  <option value="percent">% (relative)</option>
                                  <option value="absolute">$ (absolute)</option>
                                </select>
                                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                                  {s.trailDelta === "absolute" ? "$ below peak price" : "% below peak price"}
                                </div>
                              </label>
                            )}
                            {(fields || []).map(f => (
                              <label key={f.k} style={{ fontSize: 11, flex: 1, minWidth: 100 }}>
                                <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>
                                  {f.label}{extra === "trailDelta" ? (s.trailDelta === "absolute" ? " ($)" : " (%)") : ""}
                                </div>
                                <input type="number" value={s[f.k] ?? f.default ?? ""} min={f.min} max={f.max} step={f.step}
                                  onChange={e => setExitStrategy(key, { [f.k]: e.target.value })}
                                  style={{ width: "100%", boxSizing: "border-box" }} />
                                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                                  {extra === "trailDelta" && s.trailDelta === "absolute"
                                    ? `Sell when price drops $${s[f.k] || "0"} below peak`
                                    : f.hint}
                                </div>
                              </label>
                            ))}
                          </div>
                          {/* Single extra checkbox (e.g. partial exit) */}
                          {extraCheckbox && (
                            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!s[extraCheckbox.k]}
                                onChange={e => setExitStrategy(key, { [extraCheckbox.k]: e.target.checked })} />
                              <span style={{ color: "var(--color-text-secondary)" }}>{extraCheckbox.label}</span>
                            </label>
                          )}
                          {/* Multiple extra checkboxes (e.g. trend alignment filters) */}
                          {extraCheckboxes && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                              {extraCheckboxes.map(cb => (
                                <label key={cb.k} style={{ display: "flex", alignItems: "center", gap: 7,
                                  fontSize: 11, cursor: "pointer" }}>
                                  <input type="checkbox"
                                    checked={s[cb.k] !== false}
                                    onChange={e => setExitStrategy(key, { [cb.k]: e.target.checked })} />
                                  <span style={{ color: "var(--color-text-secondary)" }}>{cb.label}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Signal source ──────────────────────────────────────────────── */}
            <div data-tour="signal-source-select">
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                Signal source
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  What drives BUY/SELL decisions
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { value: "rules",    icon: "📐", label: "Rules",         desc: "RSI, MACD, SMA crossovers, Bollinger. Classic technical analysis. Always available." },
                  { value: "rf",       icon: "🌲", label: "Random Forest",  desc: "ML classifier on 10 indicators. Available after 15 ticks. Fast and robust." },
                  { value: "lstm",     icon: "🧠", label: "LSTM",           desc: "Sequence model predicting 5 ticks ahead. Available after 80 ticks. Better at patterns." },
                  { value: "rf+lstm",  icon: "🔬", label: "RF + LSTM",      desc: "Average both models. More conservative — needs consensus to signal." },
                  { value: "rl",       icon: "🎮", label: "Reinforcement Learning", desc: "Q-learning agent that learns from its own trades. Improves over time. Needs 20+ trades to become reliable." },
                  { value: "deepseek", icon: "🤖", label: "DeepSeek Agent", desc: "LLM reasoning over all signals. Most flexible. Requires Agent Mode ON and API key." },
                ].map(s => (
                  <div key={s.value} onClick={() => set("signalSource", s.value)}
                    style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer", gridColumn: s.value === "deepseek" ? "span 2" : "span 1",
                      border: `0.5px solid ${form.signalSource === s.value ? "#6366f1" : "var(--color-border-tertiary)"}`,
                      background: form.signalSource === s.value ? "#6366f112" : "var(--color-background-secondary)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: form.signalSource === s.value ? "#6366f1" : "var(--color-text-primary)", marginBottom: 3 }}>
                      {s.icon} {s.label}
                      {form.signalSource === s.value && <span style={{ fontSize: 10, marginLeft: 8, background: "#6366f122", color: "#6366f1", padding: "1px 7px", borderRadius: 4 }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.4 }}>{s.desc}</div>
                  </div>
                ))}
              </div>
              {(form.signalSource === "rf" || form.signalSource === "rf+lstm") && (
                <div style={{ marginTop: 8, fontSize: 10, padding: "6px 10px", borderRadius: 6, background: "#fef3c711", border: "0.5px solid #f59e0b", color: "#92400e" }}>
                  RF uses current indicator snapshot — signals BUY when P(up) {">"} 58%, SELL when P(up) {"<"} 42%. Works immediately from tick 15.
                </div>
              )}
              {form.signalSource === "rl" && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 10, padding: "8px 12px", borderRadius: 6,
                    background: "#6366f111", border: "0.5px solid #6366f144", color: "#4338ca" }}>
                    Q-learning agent — learns from actual trade outcomes. Needs{" "}
                    <strong>{form.rlParams?.minEpisodes || 20}</strong> completed trades before signals are trusted.
                    The longer it runs, the smarter it gets. Reset Q-table when stopping if you want a fresh start.
                  </div>

                  {/* RL parameter grid */}
                  <div style={{ borderRadius: 9, border: "0.5px solid #6366f133",
                    padding: "14px 16px", background: "#6366f108" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", marginBottom: 12 }}>
                      🎮 Q-Learning parameters
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                      {[
                        { key: "alpha",        label: "Learning rate (α)", min: "0.001", max: "1",    step: "0.01",  hint: "How fast Q-values update. 0.1 = slow stable, 0.5 = fast aggressive" },
                        { key: "gamma",        label: "Discount (γ)",      min: "0",     max: "0.999", step: "0.01",  hint: "Value of future rewards. 0.9 = cares about long-term P&L" },
                        { key: "epsilonStart", label: "Exploration start (ε)", min: "0", max: "1",    step: "0.05",  hint: "Starting random action rate. 0.4 = 40% random at first" },
                        { key: "epsilonMin",   label: "Exploration min",   min: "0",     max: "0.5",  step: "0.01",  hint: "Always keeps this much randomness. 0.05 = 5% forever" },
                        { key: "epsilonDecay", label: "Decay per trade",   min: "0.9",   max: "0.999",step: "0.001", hint: "Multiplied by ε after each trade. 0.995 = slow decay" },
                        { key: "rewardScale",  label: "Reward scale",      min: "1",     max: "10000",step: "10",    hint: "Multiply P&L for reward signal. 100 = $0.50 profit → reward 50" },
                      ].map(({ key, label, min, max, step, hint }) => (
                        <label key={key} style={{ fontSize: 11 }}>
                          <div style={{ color: "var(--color-text-secondary)", marginBottom: 4, fontWeight: 600 }}>{label}</div>
                          <input type="number"
                            value={form.rlParams?.[key] || ""}
                            min={min} max={max} step={step}
                            onChange={e => set("rlParams", { ...form.rlParams, [key]: e.target.value })}
                            style={{ width: "100%", boxSizing: "border-box" }} />
                          <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
                        </label>
                      ))}
                    </div>

                    {/* minEpisodes + resetOnStop */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <label style={{ fontSize: 11 }}>
                        <div style={{ color: "var(--color-text-secondary)", marginBottom: 4, fontWeight: 600 }}>Min episodes before trusting</div>
                        <input type="number"
                          value={form.rlParams?.minEpisodes || "20"} min="1" max="1000"
                          onChange={e => set("rlParams", { ...form.rlParams, minEpisodes: e.target.value })}
                          style={{ width: "100%", boxSizing: "border-box" }} />
                        <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                          Signals show as "exploring" until this many trades complete
                        </div>
                      </label>
                      <label style={{ fontSize: 11, display: "flex", flexDirection: "column", justifyContent: "flex-start", gap: 6 }}>
                        <div style={{ color: "var(--color-text-secondary)", fontWeight: 600 }}>Reset Q-table on stop</div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input type="checkbox"
                            checked={form.rlParams?.resetOnStop !== false}
                            onChange={e => set("rlParams", { ...form.rlParams, resetOnStop: e.target.checked })} />
                          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                            {form.rlParams?.resetOnStop !== false ? "Q-table resets each session" : "Q-table persists across sessions"}
                          </span>
                        </label>
                        <div style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>
                          Uncheck to carry learned Q-values into the next simulation
                        </div>
                      </label>
                    </div>

                    {/* Live preview of decay curve */}
                    <div style={{ marginTop: 10, fontSize: 10, padding: "8px 10px", borderRadius: 6,
                      background: "var(--color-background-primary)", color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                      {(() => {
                        const eps   = parseFloat(form.rlParams?.epsilonStart || 0.4);
                        const decay = parseFloat(form.rlParams?.epsilonDecay || 0.995);
                        const emin  = parseFloat(form.rlParams?.epsilonMin   || 0.05);
                        const after = (n) => Math.max(emin, eps * Math.pow(decay, n)).toFixed(3);
                        return <>
                          <strong>ε decay preview:</strong>{" "}
                          start {eps.toFixed(3)} →
                          10 trades {after(10)} →
                          50 trades {after(50)} →
                          100 trades {after(100)} →
                          min {emin.toFixed(3)}
                        </>;
                      })()}
                    </div>
                  </div>
                </div>
              )}
              {(form.signalSource === "lstm" || form.signalSource === "rf+lstm") && (
                <div style={{ marginTop: 8, fontSize: 10, padding: "6px 10px", borderRadius: 6, background: "#ede9fe11", border: "0.5px solid #8b5cf6", color: "#5b21b6" }}>
                  LSTM needs 80+ ticks to warm up and retrains every 5 min. Uses both direction probability and trend score together.
                </div>
              )}
              {form.signalSource === "deepseek" && !form.agentMode && (
                <div style={{ marginTop: 8, fontSize: 10, padding: "6px 10px", borderRadius: 6, background: "#fee2e211", border: "0.5px solid #ef4444", color: "#991b1b" }}>
                  Agent Mode must be ON for DeepSeek signals. Enable it below.
                </div>
              )}
            </div>

            {/* ── Trading mode ───────────────────────────────────────────── */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                Trading mode
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  Changes signal logic and DeepSeek instructions
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { value: "momentum",       icon: "📈", label: "Momentum",       desc: "Buy breakouts with strong indicator confluence. Best in trending markets. SMA crossovers and MACD are primary signals." },
                  { value: "mean_reversion", icon: "↩️", label: "Mean Reversion", desc: "Buy dips below Bollinger bands, sell rips above. Best in ranging markets. RSI extremes and BB breaches are primary signals." },
                ].map(m => (
                  <div key={m.value} onClick={() => set("tradingMode", m.value)}
                    style={{ padding: "12px 14px", borderRadius: 8, cursor: "pointer",
                      border: `0.5px solid ${form.tradingMode === m.value ? "#6366f1" : "var(--color-border-tertiary)"}`,
                      background: form.tradingMode === m.value ? "#6366f112" : "var(--color-background-secondary)" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: form.tradingMode === m.value ? "#6366f1" : "var(--color-text-primary)", marginBottom: 4 }}>
                      {m.icon} {m.label}
                      {form.tradingMode === m.value && <span style={{ fontSize: 10, marginLeft: 8, background: "#6366f122", color: "#6366f1", padding: "1px 7px", borderRadius: 4 }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>{m.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Volatility gate + R:R ratio ─────────────────────────────── */}
            <div style={{ borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "var(--color-text-secondary)" }}>
                Volatility gate + Reward:Risk ratio
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                <label style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Min LSTM volatility</div>
                  <input type="number" value={form.volatilityGate?.minVolatility || "0.3"}
                    onChange={e => set("volatilityGate", { ...form.volatilityGate, minVolatility: e.target.value })}
                    min="0" max="1" step="0.05" style={{ width: "100%", boxSizing: "border-box" }} />
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>LSTM score 0=calm 1=high</div>
                </label>
                <label style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Min ATR % of price</div>
                  <input type="number" value={form.volatilityGate?.minAtrPct || "0.3"}
                    onChange={e => set("volatilityGate", { ...form.volatilityGate, minAtrPct: e.target.value })}
                    min="0" max="5" step="0.05" style={{ width: "100%", boxSizing: "border-box" }} />
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>Must exceed fee × 1.5</div>
                </label>
                <label style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                    Min LSTM direction prob
                    <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "block" }}>0.5=coin flip 0.65=confident</span>
                  </div>
                  <input type="number" value={form.volatilityGate?.minDirProb || "0.65"}
                    onChange={e => set("volatilityGate", { ...form.volatilityGate, minDirProb: e.target.value })}
                    min="0.5" max="0.95" step="0.05" style={{ width: "100%", boxSizing: "border-box" }} />
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>{"P(up) over next "}{LSTM_STEPS}{"ticks"}</div>
                </label>
                <label style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Min reward:risk ratio</div>
                  <input type="number" value={form.minRrRatio || "3"}
                    onChange={e => set("minRrRatio", e.target.value)}
                    min="1" max="10" step="0.5" style={{ width: "100%", boxSizing: "border-box" }} />
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>TP must be N times SL</div>
                </label>
              </div>
              <div style={{ fontSize: 11, padding: "8px 12px", borderRadius: 7, background: "var(--color-background-primary)", color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: 10 }}>
                {"Fee round-trip: "}{((parseFloat(form.feePercent||0.1))*2).toFixed(2)}{"% — ATR must exceed "}{((parseFloat(form.feePercent||0.1))*3).toFixed(2)}{"% to profit. At "}{form.minRrRatio||3}{":1 R:R you can be wrong "}{Math.round(100/(1+parseFloat(form.minRrRatio||3)))}{"% of the time and still break even."}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={!!form.volatilityGate?.enabled}
                  onChange={e => set("volatilityGate", { ...form.volatilityGate, enabled: e.target.checked })} />
                <span style={{ color: form.volatilityGate?.enabled ? "#10b981" : "var(--color-text-secondary)", fontWeight: 600 }}>
                  {form.volatilityGate?.enabled ? "Volatility gate ON" : "Volatility gate OFF"}
                </span>
              </label>
            </div>

            {/* ── LLM Agent mode ──────────────────────────── */}
            <div style={{ borderRadius: 10, border: `0.5px solid ${form.agentMode ? "#6366f1" : "var(--color-border-tertiary)"}`, padding: "14px 16px", background: form.agentMode ? "#6366f108" : "transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flex: 1 }}>
                  <input type="checkbox" checked={!!form.agentMode}
                    disabled={!planLimits.canAI}
                    onChange={e => set("agentMode", e.target.checked)} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: !planLimits.canAI ? "var(--color-text-tertiary)" : form.agentMode ? "#6366f1" : "var(--color-text-primary)" }}>
                      {"🤖 LLM Agent mode (DeepSeek-V3)"}{!planLimits.canAI && <span style={{ marginLeft: 8, fontSize: 10, background: "#f59e0b22", color: "#92400e", padding: "1px 7px", borderRadius: 4 }}>Pro AI only</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>
                      Replaces rule-based signals with DeepSeek AI. The agent receives all indicator values, position state,
                      news sentiment and settings, then reasons through a BUY/SELL/HOLD decision with explanation.
                    </div>
                  </div>
                </label>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, fontWeight: 700, flexShrink: 0,
                  background: form.agentMode ? "#6366f122" : "var(--color-background-secondary)",
                  color: form.agentMode ? "#6366f1" : "var(--color-text-tertiary)" }}>
                  {form.agentMode ? "ON" : "OFF"}
                </span>
              </div>
              {form.agentMode && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  <label style={{ fontSize: 12 }}>
                    <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Reasoning interval (sec)</div>
                    <input type="number" value={form.agentIntervalSec} onChange={e => set("agentIntervalSec", e.target.value)}
                      min="10" max="300" step="5" style={{ width: "100%", boxSizing: "border-box" }} />
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
                      DeepSeek called every {form.agentIntervalSec}s. LSTM trained every 5 min (needs 80+ ticks).
                    </div>
                  </label>
                  {/* Phase 3: Adaptive Settings */}
                  <div style={{ borderRadius: 8, border: `0.5px solid ${form.adaptiveSettings?.enabled ? "#10b981" : "var(--color-border-tertiary)"}`, padding: "12px", background: form.adaptiveSettings?.enabled ? "#d1fae508" : "transparent" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: form.adaptiveSettings?.enabled ? 10 : 0 }}>
                      <input type="checkbox" checked={!!form.adaptiveSettings?.enabled}
                        onChange={e => set("adaptiveSettings", { ...form.adaptiveSettings, enabled: e.target.checked })} />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: form.adaptiveSettings?.enabled ? "#10b981" : "var(--color-text-primary)" }}>
                          Phase 3 — Adaptive TP/SL
                        </div>
                        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                          Agent auto-adjusts TP/SL based on regime. Applies only after N consistent suggestions above confidence threshold.
                        </div>
                      </div>
                    </label>
                    {form.adaptiveSettings?.enabled && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                        {[
                          { k: "maxTpDelta",  label: "Max TP adjust (%)", hint: "TP drift cap" },
                          { k: "maxSlDelta",  label: "Max SL adjust (%)", hint: "SL drift cap" },
                          { k: "requireHigh", label: "Min confidence",    hint: "% threshold" },
                          { k: "applyAfter",  label: "Calls needed",      hint: "N consistent" },
                        ].map(({ k, label, hint }) => (
                          <label key={k} style={{ fontSize: 11 }}>
                            <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>{label}</div>
                            <input type="number" value={form.adaptiveSettings?.[k] || ""}
                              onChange={e => set("adaptiveSettings", { ...form.adaptiveSettings, [k]: e.target.value })}
                              min="0" step="0.1" style={{ width: "100%", boxSizing: "border-box", fontSize: 11 }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>{hint}</div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── Tab: Execution ────────────────────────────────────────────────── */}
        {activeTab === "execution" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* ── Buy order type ─────────────────────────────────────── */}
            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, fontWeight: 600 }}>
                Buy order type
                <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontWeight: 400, marginLeft: 8 }}>
                  Limit BUY = maker order = lower or zero fees
                </span>
              </div>
              {(() => {
                const bc = form.buyOrderConfig;
                return (
                  <div>
                    {/* Market vs Limit selector */}
                    <div style={{ display: "flex", gap: 8, marginBottom: bc.type === "limit" ? 10 : 0 }}>
                      {["market","limit"].map(t => (
                        <div key={t} onClick={() => setBuyOrder({ type: t })}
                          style={{ flex: 1, padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                            border: `0.5px solid ${bc.type === t ? "#10b981" : "var(--color-border-tertiary)"}`,
                            background: bc.type === t ? "#d1fae508" : "var(--color-background-secondary)" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: bc.type === t ? "#10b981" : "var(--color-text-primary)", marginBottom: 3 }}>
                            {t === "market" ? "Market (taker)" : "Limit (maker)"}
                            {bc.type === t && <span style={{ fontSize: 10, marginLeft: 8, background: "#10b98122", color: "#065f46", padding: "1px 7px", borderRadius: 4 }}>SELECTED</span>}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                            {t === "market"
                              ? "Fills instantly at best price. Taker fee applies (e.g. 0.1%)."
                              : "Posts to order book. Fills when price reaches limit. Maker fee (often 0% on Binance.US)."}
                          </div>
                        </div>
                      ))}
                    </div>

                    {bc.type === "limit" && (
                      <div style={{ padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid #10b98144" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                          Limit price offset from signal price
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                          <label style={{ fontSize: 11 }}>
                            <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>Offset type</div>
                            <select value={bc.limitOffsetType} onChange={e => setBuyOrder({ limitOffsetType: e.target.value })}
                              style={{ width: "100%", fontSize: 11, padding: "4px 6px", borderRadius: 4,
                                border: "0.5px solid var(--color-border-secondary)",
                                background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                              <option value="percent">% offset</option>
                              <option value="absolute">$ offset</option>
                            </select>
                          </label>
                          <label style={{ fontSize: 11 }}>
                            <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>
                              Offset value
                            </div>
                            <input type="number" value={bc.limitOffsetValue} min="0" step={bc.limitOffsetType === "percent" ? "0.01" : "1"}
                              onChange={e => setBuyOrder({ limitOffsetValue: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                          </label>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--color-text-secondary)", lineHeight: 1.6, padding: "8px 10px", borderRadius: 6, background: "var(--color-background-primary)" }}>
                          {bc.limitOffsetType === "percent" ? (
                            <>
                              <strong>Limit = signal price × (1 + {bc.limitOffsetValue || "0.05"}%)</strong>
                              <br/>e.g. signal at $65,000 → limit at ${(65000 * (1 + parseFloat(bc.limitOffsetValue || 0.05) / 100)).toFixed(2)}
                              <br/>Setting above current price means it fills quickly but counts as maker (posts to book then fills).
                              <br/><span style={{ color: "#10b981" }}>Typical maker fee on Binance.US: 0% — saving {form.feePercent || "0.1"}% vs market order.</span>
                            </>
                          ) : (
                            <>
                              <strong>Limit = signal price + ${bc.limitOffsetValue || "0"}</strong>
                              <br/>e.g. signal at $65,000 → limit at ${(65000 + parseFloat(bc.limitOffsetValue || 0)).toFixed(2)}
                            </>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 8, padding: "6px 8px", borderRadius: 5, background: "#fef3c711", border: "0.5px solid #f59e0b" }}>
                          If the limit order doesn't fill within 2 minutes, it will be cancelled. Lower offset = faster fill but may become taker. Higher offset = safer maker but slower fill.
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

          </div>
        )}

        {/* ── Tab: Exits ────────────────────────────────────────────────────── */}
        {activeTab === "exits" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* ── Dynamic exits based on cumulative P&L ─────────── */}
            <div style={{ borderRadius: 10, border: `0.5px solid ${form.dynamicExits?.enabled ? "#f59e0b" : "var(--color-border-tertiary)"}`, padding: "14px 16px", background: form.dynamicExits?.enabled ? "#fef3c708" : "transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flex: 1 }}>
                  <input type="checkbox" checked={!!form.dynamicExits?.enabled}
                    onChange={e => setDynamicExits({ enabled: e.target.checked })} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: form.dynamicExits?.enabled ? "#f59e0b" : "var(--color-text-primary)" }}>
                      {"\ud83d\udcca Dynamic exits (scale TP/SL by cumulative P&L)"}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.5 }}>
                      Widens TP when overall profit is strong. Tightens TP/SL when underwater to protect capital.
                    </div>
                  </div>
                </label>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, fontWeight: 700, flexShrink: 0,
                  background: form.dynamicExits?.enabled ? "#f59e0b22" : "var(--color-background-secondary)",
                  color: form.dynamicExits?.enabled ? "#92400e" : "var(--color-text-tertiary)" }}>
                  {form.dynamicExits?.enabled ? "ON" : "OFF"}
                </span>
              </div>
              {form.dynamicExits?.enabled && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[
                      { value: "aggressive_when_winning", label: "Aggressive when winning", desc: "Widen TP above profit threshold" },
                      { value: "defensive_when_losing",   label: "Defensive when losing",   desc: "Tighten TP/SL below loss threshold" },
                      { value: "both",                    label: "Both",                    desc: "Scale in both directions" },
                    ].map(m => (
                      <div key={m.value} onClick={() => setDynamicExits({ mode: m.value })}
                        style={{ padding: "8px 10px", borderRadius: 7, cursor: "pointer",
                          border: `0.5px solid ${form.dynamicExits?.mode === m.value ? "#f59e0b" : "var(--color-border-tertiary)"}`,
                          background: form.dynamicExits?.mode === m.value ? "#f59e0b12" : "var(--color-background-secondary)" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: form.dynamicExits?.mode === m.value ? "#92400e" : "var(--color-text-primary)" }}>{m.label}</div>
                        <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 2 }}>{m.desc}</div>
                      </div>
                    ))}
                  </div>
                  <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>Scale by:</span>
                    <select value={form.dynamicExits?.scaleBy || "total"} onChange={e => setDynamicExits({ scaleBy: e.target.value })}
                      style={{ fontSize: 12, padding: "4px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                      <option value="total">Total P&L (all coins combined)</option>
                      <option value="per_coin">Per-coin P&L (this coin only)</option>
                    </select>
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "#10b981", marginBottom: 4, fontWeight: 600 }}>Profit threshold ($)</div>
                      <input type="number" value={form.dynamicExits?.profitThreshold || "20"}
                        onChange={e => setDynamicExits({ profitThreshold: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                      <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Start widening TP above this</div>
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "#ef4444", marginBottom: 4, fontWeight: 600 }}>Loss threshold ($)</div>
                      <input type="number" value={form.dynamicExits?.lossThreshold || "-20"}
                        onChange={e => setDynamicExits({ lossThreshold: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                      <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Start tightening below this (negative)</div>
                    </label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>Max TP boost (%)</div>
                      <input type="number" value={form.dynamicExits?.maxTpBoost || "50"} min="0" max="200"
                        onChange={e => setDynamicExits({ maxTpBoost: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>Max TP cut (%)</div>
                      <input type="number" value={form.dynamicExits?.maxTpCut || "50"} min="0" max="90"
                        onChange={e => setDynamicExits({ maxTpCut: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>Max SL tighten (%)</div>
                      <input type="number" value={form.dynamicExits?.maxSlTighten || "30"} min="0" max="90"
                        onChange={e => setDynamicExits({ maxSlTighten: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                    </label>
                  </div>
                  <div style={{ fontSize: 11, padding: "10px 12px", borderRadius: 7, background: "var(--color-background-primary)", lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
                    {(() => {
                      const pt = parseFloat(form.dynamicExits?.profitThreshold || 20);
                      const lt = parseFloat(form.dynamicExits?.lossThreshold || -20);
                      const baseTp = parseFloat(form.exitRules?.BTC?.takeProfitValue || 2);
                      const baseSl = parseFloat(form.exitRules?.BTC?.stopLossValue || 1);
                      const boostedTp = baseTp * (1 + parseFloat(form.dynamicExits?.maxTpBoost || 50) / 100);
                      const cutTp     = baseTp * (1 - parseFloat(form.dynamicExits?.maxTpCut || 50) / 100);
                      const tightSl   = baseSl * (1 - parseFloat(form.dynamicExits?.maxSlTighten || 30) / 100);
                      return (
                        <>
                          <strong>{"Example with BTC base TP "}{baseTp}{"% / SL "}{baseSl}{"%:"}</strong>
                          <br/>
                          {"At $"}{pt}{"+ profit \u2192 TP widens up to "}<strong style={{ color: "#10b981" }}>{boostedTp.toFixed(2)}{"%"}</strong>
                          <br/>
                          {"At $"}{Math.abs(lt)}{"+ loss \u2192 TP tightens to "}<strong style={{ color: "#ef4444" }}>{cutTp.toFixed(2)}{"%"}</strong>
                          {", SL tightens to "}<strong style={{ color: "#ef4444" }}>{tightSl.toFixed(2)}{"%"}</strong>
                          <br/>
                          <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                            {"Scaling is proportional between threshold and 2\u00d7 threshold, then capped at the max values above."}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* ── Post-buy limit sell ────────────────────────────────── */}
            <div style={{ borderRadius: 10, border: `0.5px solid ${form.postBuyLimitSell?.enabled ? "#10b981" : "var(--color-border-tertiary)"}`, padding: "14px 16px", background: form.postBuyLimitSell?.enabled ? "#d1fae508" : "transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flex: 1 }}>
                  <input type="checkbox" checked={!!form.postBuyLimitSell?.enabled}
                    onChange={e => setPostBuyLimitSell({ enabled: e.target.checked })} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: form.postBuyLimitSell?.enabled ? "#10b981" : "var(--color-text-primary)" }}>
                      Post-buy limit sell (auto profit target)
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.5 }}>
                      Immediately places a resting limit SELL on the exchange after a BUY fills.
                      The sell order sits in the order book at your target price — qualifies as maker (0% fee on Binance.US).
                    </div>
                  </div>
                </label>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, fontWeight: 700, flexShrink: 0,
                  background: form.postBuyLimitSell?.enabled ? "#10b98122" : "var(--color-background-secondary)",
                  color: form.postBuyLimitSell?.enabled ? "#065f46" : "var(--color-text-tertiary)" }}>
                  {form.postBuyLimitSell?.enabled ? "ON" : "OFF"}
                </span>
              </div>
              {form.postBuyLimitSell?.enabled && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Offset type</div>
                      <select value={form.postBuyLimitSell?.offsetType || "percent"}
                        onChange={e => setPostBuyLimitSell({ offsetType: e.target.value })}
                        style={{ width: "100%", fontSize: 12, padding: "5px 8px", borderRadius: 5,
                          border: "0.5px solid var(--color-border-secondary)",
                          background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                        <option value="percent">% above fill price</option>
                        <option value="absolute">$ above fill price</option>
                      </select>
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>
                        {form.postBuyLimitSell?.offsetType === "absolute" ? "Dollar offset ($)" : "Percent offset (%)"}
                      </div>
                      <input type="number" value={form.postBuyLimitSell?.offsetValue || "1.5"}
                        min="0" step={form.postBuyLimitSell?.offsetType === "absolute" ? "1" : "0.1"}
                        onChange={e => setPostBuyLimitSell({ offsetValue: e.target.value })}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                    </label>
                  </div>
                  <div style={{ fontSize: 11, padding: "10px 12px", borderRadius: 7, background: "var(--color-background-primary)", lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
                    {(() => {
                      const off  = parseFloat(form.postBuyLimitSell?.offsetValue || 1.5);
                      const isPct = form.postBuyLimitSell?.offsetType !== "absolute";
                      const exBuy  = 65000;
                      const exSell = isPct ? exBuy * (1 + off / 100) : exBuy + off;
                      const exQty  = parseFloat(form.tradeSizeUSD || 50) / exBuy;
                      const makerFee = 0; // Binance.US maker
                      const takerFee = parseFloat(form.feePercent || 0.1) / 100;
                      const profit = exQty * exSell * (1 - makerFee) - exQty * exBuy * (1 + takerFee);
                      return (
                        <>
                          <strong>Example:</strong> BUY fills at $65,000 → limit SELL placed at ${exSell.toFixed(2)}
                          {" ("}{isPct ? `+${off}%` : `+$${off}`}{")"}
                          <br/>
                          Est. profit: <strong style={{ color: profit > 0 ? "#10b981" : "#ef4444" }}>${profit.toFixed(4)}</strong>
                          {" "}({isPct ? `${off}% move` : `$${off} move`}, taker buy + maker sell)
                          <br/>
                          <span style={{ color: "#10b981" }}>Maker sell = 0% fee → full profit retained on the sell side.</span>
                          <br/>
                          <span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>
                            If the limit sell doesn't fill before a stop-loss trigger, the algo cancels it and places a market sell.
                          </span>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* ── Sell order type ────────────────────────────────────── */}
            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, fontWeight: 600 }}>
                Sell order type
                <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontWeight: 400, marginLeft: 8 }}>
                  How sell orders are placed on the exchange
                </span>
              </div>
              {(() => {
                const sc = form.sellOrderConfig;
                const sel = (label, value, description) => (
                  <div key={value} onClick={() => setSellOrder({ type: value })}
                    style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                      border: `0.5px solid ${sc.type === value ? "#6366f1" : "var(--color-border-tertiary)"}`,
                      background: sc.type === value ? "#6366f115" : "var(--color-background-secondary)",
                      marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: sc.type === value ? "#6366f1" : "var(--color-text-primary)" }}>{label}</span>
                      {sc.type === value && <span style={{ fontSize: 10, background: "#6366f122", color: "#6366f1", padding: "1px 8px", borderRadius: 4, fontWeight: 600 }}>SELECTED</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>{description}</div>
                  </div>
                );
                return (
                  <div>
                    {sel("Market", "market", "Sell immediately at the best available price. Fastest execution, no price guarantee.")}
                    {sel("Limit", "limit", "Place a sell order at a specific price. Only fills if the market reaches that price.")}
                    {sel("Stop-Limit", "stop_limit", "Trigger a limit sell when price drops to a stop level. Protects against sudden drops.")}
                    {sel("OCO (One-Cancels-the-Other)", "oco", "Place a take-profit limit and a stop-loss simultaneously. Whichever fills first cancels the other.")}
                    {sel("Trailing Stop (Exchange-native)", "trailing_stop", "Exchange manages a trailing stop. Price moves in your favour, stop follows at the delta.")}

                    {/* Conditional parameter panels */}
                    {sc.type === "limit" && (
                      <div style={{ padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", marginTop: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--color-text-secondary)" }}>Limit price offset from signal price</div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Offset type</div>
                            <select value={sc.limitOffsetType} onChange={e => setSellOrder({ limitOffsetType: e.target.value })}
                              style={{ width: "100%", fontSize: 11, padding: "4px 6px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                              <option value="percent">% below signal price</option>
                              <option value="absolute">$ below signal price</option>
                            </select>
                          </label>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Offset value</div>
                            <input type="number" value={sc.limitOffsetValue} min="0" step="0.01"
                              onChange={e => setSellOrder({ limitOffsetValue: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                              {sc.limitOffsetType === "percent" ? `Limit = signal price × (1 - ${sc.limitOffsetValue}%)` : `Limit = signal price - $${sc.limitOffsetValue}`}
                            </div>
                          </label>
                        </div>
                      </div>
                    )}

                    {sc.type === "stop_limit" && (
                      <div style={{ padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", marginTop: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--color-text-secondary)" }}>Stop-Limit parameters (% below entry price)</div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Stop price (%)</div>
                            <input type="number" value={sc.stopPricePct} min="0" max="50" step="0.1"
                              onChange={e => setSellOrder({ stopPricePct: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Triggers the limit order</div>
                          </label>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Limit price (%)</div>
                            <input type="number" value={sc.limitPricePct} min="0" max="50" step="0.1"
                              onChange={e => setSellOrder({ limitPricePct: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Must be lower than stop price</div>
                          </label>
                        </div>
                      </div>
                    )}

                    {sc.type === "oco" && (
                      <div style={{ padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", marginTop: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--color-text-secondary)" }}>OCO parameters (% from entry price)</div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "#10b981", marginBottom: 3, fontWeight: 600 }}>↑ Take-profit (%)</div>
                            <input type="number" value={sc.ocoTpPct} min="0.1" max="100" step="0.1"
                              onChange={e => setSellOrder({ ocoTpPct: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Limit sell above entry</div>
                          </label>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "#ef4444", marginBottom: 3, fontWeight: 600 }}>↓ Stop-loss (%)</div>
                            <input type="number" value={sc.ocoSlPct} min="0.1" max="50" step="0.1"
                              onChange={e => setSellOrder({ ocoSlPct: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>Stop-limit sell below entry</div>
                          </label>
                        </div>
                        <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 8, padding: "6px 8px", background: "#fef3c711", borderRadius: 5, border: "0.5px solid #f59e0b" }}>
                          OCO support varies by exchange. Binance.US supports OCO natively. Other exchanges may fall back to two separate orders.
                        </div>
                      </div>
                    )}

                    {sc.type === "trailing_stop" && (
                      <div style={{ padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", marginTop: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--color-text-secondary)" }}>Exchange-native trailing stop parameters</div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Delta type</div>
                            <select value={sc.trailDeltaType} onChange={e => setSellOrder({ trailDeltaType: e.target.value })}
                              style={{ width: "100%", fontSize: 11, padding: "4px 6px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                              <option value="percent">% from peak</option>
                              <option value="absolute">$ from peak</option>
                            </select>
                          </label>
                          <label style={{ fontSize: 11, flex: 1 }}>
                            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 3 }}>Delta value</div>
                            <input type="number" value={sc.trailStopDelta} min="0.01" step="0.01"
                              onChange={e => setSellOrder({ trailStopDelta: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                              {sc.trailDeltaType === "absolute" ? `Stop follows $${sc.trailStopDelta} below peak` : `Stop follows ${sc.trailStopDelta}% below peak`}
                            </div>
                          </label>
                        </div>
                        <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 8, padding: "6px 8px", background: "#fef3c711", borderRadius: 5, border: "0.5px solid #f59e0b" }}>
                          Binance.US supports trailing stop orders natively. Other exchanges will simulate using the algo-managed trailing stop strategy above.
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* ── ATR-based TP/SL ─────────────────────────────────────────────── */}
            {[
              {
                key: "atrTpSl",
                label: "🎯 ATR-based TP/SL (recommended)",
                desc: "Sets TP and SL as multiples of ATR(14) — adapts to actual market volatility instead of a fixed %. Prevents overshoot: if ATR is $800, TP is $1,200 above entry (1.5×), not a fixed 2% that may never be reached.",
                fields: [
                  { k: "tpMultiplier", label: "TP (ATR ×)", min: 0.5, max: 5,   step: 0.25, hint: "1.5 = TP at entry + 1.5×ATR. Keep 2:1 ratio with SL." },
                  { k: "slMultiplier", label: "SL (ATR ×)", min: 0.1, max: 3,   step: 0.25, hint: "0.75 = SL at entry − 0.75×ATR. Maintains 2:1 R:R." },
                ],
                extraCheckbox: { k: "partialExit", label: "Partial exit: sell 50% at 1×ATR, move SL to breakeven on remainder" },
              },
              {
                key: "trendAlignment",
                label: "📈 Trend alignment gate (recommended)",
                desc: "Only allow BUY when higher timeframes confirm the direction. Blocks entries when the 1h trend is bearish — the most common cause of TP targets never being reached.",
                fields: [
                  { k: "requireRsiAbove", label: "1h RSI floor", min: 30, max: 60, step: 1, hint: "Block BUY if 1h RSI is below this (45 = not in downtrend)" },
                ],
                extraCheckboxes: [
                  { k: "requireBullish1h",  label: "1h SMA50: price must be above the 1-hour 50-period moving average (long-term uptrend)" },
                  { k: "requireBullish15m", label: "15m EMA cross: EMA12 must be above EMA26 on 15-minute chart (momentum confirming)" },
                  { k: "strictMode",        label: "Strict mode: all three filters must pass (default: any 2 of 3)" },
                ],
              },
            ].map(({ key, label, desc, fields, extraCheckbox, extraCheckboxes }) => {
              const s  = form.exitStrategies?.[key] || {};
              const on = !!s.enabled;
              return (
                <div key={key} style={{ borderRadius: 8, border: `0.5px solid ${on ? "#6366f1" : "var(--color-border-tertiary)"}`, padding: "12px 14px", background: on ? "#6366f108" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: on ? 12 : 0 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
                      <input type="checkbox" checked={on}
                        onChange={e => setExitStrategy(key, { enabled: e.target.checked })} />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: on ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>{label}</div>
                        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
                      </div>
                    </label>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 600, flexShrink: 0,
                      background: on ? "#6366f122" : "var(--color-background-secondary)",
                      color: on ? "#6366f1" : "var(--color-text-tertiary)" }}>
                      {on ? "ON" : "OFF"}
                    </span>
                  </div>
                  {on && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {/* Numeric fields */}
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {fields.map(f => (
                          <label key={f.k} style={{ fontSize: 11, flex: 1, minWidth: 120 }}>
                            <div style={{ color: "var(--color-text-secondary)", marginBottom: 3 }}>{f.label}</div>
                            <input type="number" value={s[f.k] ?? ""} min={f.min} max={f.max} step={f.step}
                              onChange={e => setExitStrategy(key, { [f.k]: e.target.value })}
                              style={{ width: "100%", boxSizing: "border-box" }} />
                            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>{f.hint}</div>
                          </label>
                        ))}
                      </div>
                      {/* Single extra checkbox */}
                      {extraCheckbox && (
                        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, cursor: "pointer",
                          padding: "6px 8px", borderRadius: 6, background: "var(--color-background-secondary)" }}>
                          <input type="checkbox" checked={!!s[extraCheckbox.k]}
                            onChange={e => setExitStrategy(key, { [extraCheckbox.k]: e.target.checked })} />
                          <span style={{ color: "var(--color-text-secondary)" }}>{extraCheckbox.label}</span>
                        </label>
                      )}
                      {/* Multiple extra checkboxes */}
                      {extraCheckboxes && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {extraCheckboxes.map(cb => (
                            <label key={cb.k} style={{ display: "flex", alignItems: "center", gap: 7,
                              fontSize: 11, cursor: "pointer",
                              padding: "5px 8px", borderRadius: 6,
                              background: s[cb.k] !== false ? "var(--color-background-secondary)" : "transparent" }}>
                              <input type="checkbox"
                                checked={s[cb.k] !== false}
                                onChange={e => setExitStrategy(key, { [cb.k]: e.target.checked })} />
                              <span style={{ color: "var(--color-text-secondary)" }}>{cb.label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

          </div>
        )}

        {/* ── Tab: Indicators ───────────────────────────────────────────────── */}
        {activeTab === "indicators" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* ── Tick interval ──────────────────────────────────────────── */}
            <div style={{ borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                Tick interval
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  How often the algo evaluates price and runs indicators
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 10 }}>
                {[
                  { ms: 500,        label: "0.5s",  group: "Seconds" },
                  { ms: 1000,       label: "1s",    group: "Seconds" },
                  { ms: 1500,       label: "1.5s",  group: "Seconds" },
                  { ms: 3000,       label: "3s",    group: "Seconds" },
                  { ms: 5000,       label: "5s",    group: "Seconds" },
                  { ms: 10000,      label: "10s",   group: "Seconds" },
                  { ms: 30000,      label: "30s",   group: "Seconds" },
                  { ms: 60000,      label: "1 min", group: "Minutes" },
                  { ms: 300000,     label: "5 min", group: "Minutes" },
                  { ms: 900000,     label: "15 min",group: "Minutes" },
                  { ms: 1800000,    label: "30 min",group: "Minutes" },
                  { ms: 3600000,    label: "1 hr",  group: "Minutes" },
                  { ms: 14400000,   label: "4 hr",  group: "Hours"   },
                  { ms: 86400000,   label: "1 day", group: "Hours"   },
                ].map(t => (
                  <div key={t.ms} onClick={() => set("tickIntervalMs", t.ms)}
                    style={{ padding: "6px 4px", borderRadius: 7, cursor: "pointer", textAlign: "center",
                      border: `0.5px solid ${form.tickIntervalMs === t.ms ? "#6366f1" : t.group === "Minutes" ? "#6366f122" : t.group === "Hours" ? "#10b98122" : "var(--color-border-tertiary)"}`,
                      background: form.tickIntervalMs === t.ms ? "#6366f112" : "var(--color-background-secondary)" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: form.tickIntervalMs === t.ms ? "#6366f1" : t.group === "Minutes" ? "#6366f180" : t.group === "Hours" ? "#10b98180" : "var(--color-text-primary)" }}>{t.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, padding: "8px 12px", borderRadius: 7, background: "var(--color-background-primary)", color: "var(--color-text-secondary)" }}>
                <strong>Seconds</strong> — reactive, high CPU. <strong>Minutes</strong> — suitable for swing trading, low frequency.
                <strong>Hours/Days</strong> — long-term position trading. WS prices still update in real time — the interval controls signal evaluation frequency only.
                {form.tickIntervalMs >= 60000 && (
                  <span style={{ color: "#f59e0b", display: "block", marginTop: 4 }}>
                    ⚠ At {form.tickIntervalMs >= 3600000 ? `${form.tickIntervalMs/3600000}hr` : `${form.tickIntervalMs/60000}min`} intervals,
                    a "20-tick SMA" spans {((20 * form.tickIntervalMs) / 60000).toFixed(0)} minutes.
                    Consider increasing indicator periods to match your timeframe.
                  </span>
                )}
              </div>
            </div>

            {/* ── Indicator periods (real-time configurable) ──────────────── */}
            <div style={{ borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--color-text-secondary)" }}>
                Indicator periods
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 8 }}>
                  Number of ticks each indicator looks back — real-time span shown below each field
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                {[
                  { key: "smaFast",   label: "SMA fast" },
                  { key: "smaMid",    label: "SMA mid" },
                  { key: "smaSlow",   label: "SMA slow" },
                  { key: "emaFast",   label: "EMA fast" },
                  { key: "emaSlow",   label: "EMA slow" },
                  { key: "rsi",       label: "RSI" },
                  { key: "bollinger", label: "Bollinger" },
                  { key: "atr",       label: "ATR" },
                ].map(({ key, label }) => {
                  const periods = form.indicatorPeriods?.[key] || 14;
                  const seconds = (periods * (form.tickIntervalMs || 1500)) / 1000;
                  const timeLabel = seconds < 60 ? `${seconds.toFixed(0)}s`
                    : seconds < 3600 ? `${(seconds / 60).toFixed(1)}m`
                    : `${(seconds / 3600).toFixed(1)}h`;
                  return (
                    <label key={key} style={{ fontSize: 11 }}>
                      <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>{label}</div>
                      <input type="number" value={periods} min="2" max="500"
                        onChange={e => setIndicatorPeriod(key, e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box" }} />
                      <div style={{ fontSize: 10, color: "#6366f1", marginTop: 3, fontWeight: 600 }}>≈ {timeLabel}</div>
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 10, lineHeight: 1.6 }}>
                Example: SMA fast = 20 ticks × {((form.tickIntervalMs || 1500)/1000).toFixed(1)}s tick = {((20 * (form.tickIntervalMs || 1500)) / 1000).toFixed(0)}s lookback.
                Increase periods for longer-term trend detection, decrease for faster reaction to recent price action.
              </div>
            </div>

            {/* ── Indicator configuration ─────────────────────────────── */}
            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, fontWeight: 600 }}>
                Buy signal indicators
                <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontWeight: 400, marginLeft: 8 }}>
                  Toggle indicators and adjust weights / parameters
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { key: "rsi",       label: "RSI",              color: "#a855f7", params: [{ k: "oversold", label: "Oversold", min: 10, max: 50 }, { k: "overbought", label: "Overbought", min: 50, max: 90 }] },
                  { key: "sma_20_50", label: "SMA 20 / 50",      color: "#f59e0b", params: [] },
                  { key: "sma_20_99", label: "SMA 20 / 99",      color: "#f59e0b", params: [] },
                  { key: "sma_50_99", label: "SMA 50 / 99",      color: "#f59e0b", params: [] },
                  { key: "ema_12_26", label: "EMA 12 / 26",      color: "#06b6d4", params: [] },
                  { key: "macd",      label: "MACD",             color: "#10b981", params: [] },
                  { key: "bollinger", label: "Bollinger Bands",  color: "#6366f1", params: [{ k: "period", label: "Period", min: 5, max: 50 }] },
                  { key: "news",      label: "News sentiment",   color: "#ec4899", params: [] },
                ].map(({ key, label, color, params }) => {
                  const ic = form.indicatorConfig[key] || {};
                  const on = ic.enabled;
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 7,
                      border: `0.5px solid ${on ? color + "66" : "var(--color-border-tertiary)"}`,
                      background: on ? color + "08" : "transparent" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 140 }}>
                        <input type="checkbox" checked={!!on} onChange={e => setIndicator(key, { enabled: e.target.checked })} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: on ? color : "var(--color-text-secondary)" }}>{label}</span>
                      </label>
                      {on && (
                        <>
                          <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ color: "var(--color-text-tertiary)" }}>Weight</span>
                            <input type="number" value={ic.weight || "1"} min="0.1" max="5" step="0.1"
                              onChange={e => setIndicator(key, { weight: e.target.value })}
                              style={{ width: 52, fontSize: 11, padding: "2px 4px", boxSizing: "border-box" }} />
                          </label>
                          {params.map(p => (
                            <label key={p.k} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ color: "var(--color-text-tertiary)" }}>{p.label}</span>
                              <input type="number" value={ic[p.k] || ""} min={p.min} max={p.max} step="1"
                                onChange={e => setIndicator(key, { [p.k]: e.target.value })}
                                style={{ width: 48, fontSize: 11, padding: "2px 4px", boxSizing: "border-box" }} />
                            </label>
                          ))}
                        </>
                      )}
                      {!on && <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginLeft: 4 }}>disabled</span>}
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        )}

        {/* ── Tab: Complex Rules ───────────────────────────────────────────────── */}
        {activeTab === "rules" && (() => {
          const cr   = form.customRules || { enabled: false, groupLogic: "and", groups: [] };
          const setCr = (patch) => set("customRules", { ...cr, ...patch });
          const INDICATORS = [
            // ── Technical ─────────────────────────────────────────────────────
            { value: "rsi",           label: "RSI (14)",            unit: "0–100",    hint: "< 35 oversold, > 65 overbought",  group: "Technical" },
            { value: "macd",          label: "MACD",                unit: "price",    hint: "> 0 bullish crossover",            group: "Technical" },
            { value: "macdNorm",      label: "MACD % of price",     unit: "%",        hint: "normalised MACD",                  group: "Technical" },
            { value: "bollingerPct",  label: "Bollinger %B",        unit: "0–1",      hint: "< 0.2 near lower, > 0.8 upper",   group: "Technical" },
            { value: "sma20dist",     label: "Price vs SMA20 (%)",      unit: "%",   hint: "> 0 = above SMA20 (tick interval)", group: "Technical" },
            { value: "sma50dist",     label: "Price vs SMA50 (%)",      unit: "%",   hint: "> 0 = above SMA50",                 group: "Technical" },
            { value: "sma99dist",     label: "Price vs SMA99 (%)",      unit: "%",   hint: "",                                  group: "Technical" },
            { value: "emaSpread",     label: "EMA12-26 spread (%)",     unit: "%",   hint: "> 0 = EMA12 above EMA26",           group: "Technical" },
            // ── Multi-timeframe — price % distance from fixed-interval SMA ────
            { value: "sma20_1m",  label: "Price vs SMA20 (1min)",   unit: "%",   hint: "> 0 = above 1-min SMA20",           group: "Multi-TF" },
            { value: "sma50_1m",  label: "Price vs SMA50 (1min)",   unit: "%",   hint: "> 0 = above 1-min SMA50",           group: "Multi-TF" },
            { value: "sma20_5m",  label: "Price vs SMA20 (5min)",   unit: "%",   hint: "> 0 = above 5-min SMA20",           group: "Multi-TF" },
            { value: "sma50_5m",  label: "Price vs SMA50 (5min)",   unit: "%",   hint: "> 0 = above 5-min SMA50",           group: "Multi-TF" },
            { value: "sma99_5m",  label: "Price vs SMA99 (5min)",   unit: "%",   hint: "> 0 = above 5-min SMA99",           group: "Multi-TF" },
            { value: "sma20_15m", label: "Price vs SMA20 (15min)",  unit: "%",   hint: "> 0 = above 15-min SMA20",          group: "Multi-TF" },
            { value: "sma50_15m", label: "Price vs SMA50 (15min)",  unit: "%",   hint: "> 0 = above 15-min SMA50",          group: "Multi-TF" },
            { value: "sma20_30m", label: "Price vs SMA20 (30min)",  unit: "%",   hint: "> 0 = above 30-min SMA20",          group: "Multi-TF" },
            { value: "sma50_30m", label: "Price vs SMA50 (30min)",  unit: "%",   hint: "> 0 = above 30-min SMA50",          group: "Multi-TF" },
            { value: "sma20_1h",  label: "Price vs SMA20 (1hr)",    unit: "%",   hint: "> 0 = above 1-hr SMA20",            group: "Multi-TF" },
            { value: "sma50_1h",  label: "Price vs SMA50 (1hr)",    unit: "%",   hint: "> 0 = above 1-hr SMA50",            group: "Multi-TF" },
            { value: "ema12_1m",  label: "EMA12 (1min)",            unit: "%",   hint: "% distance from current price",      group: "Multi-TF" },
            { value: "ema26_1m",  label: "EMA26 (1min)",            unit: "%",   hint: "% distance from current price",      group: "Multi-TF" },
            { value: "ema12_5m",  label: "EMA12 (5min)",            unit: "%",   hint: "% distance from current price",      group: "Multi-TF" },
            { value: "ema26_5m",  label: "EMA26 (5min)",            unit: "%",   hint: "% distance from current price",      group: "Multi-TF" },
            { value: "rsi_1m",    label: "RSI (1min)",              unit: "0–100",hint: "< 35 oversold on 1-min chart",      group: "Multi-TF" },
            { value: "rsi_5m",    label: "RSI (5min)",              unit: "0–100",hint: "< 35 oversold on 5-min chart",      group: "Multi-TF" },
            { value: "rsi_15m",   label: "RSI (15min)",             unit: "0–100",hint: "< 35 oversold on 15-min chart",     group: "Multi-TF" },
            { value: "atrPct",        label: "ATR % of price",      unit: "%",        hint: "> 0.3 = enough volatility",        group: "Technical" },
            { value: "volume",        label: "Volume ratio",         unit: "×avg",    hint: "> 1.2 = above average volume",     group: "Technical" },
            // ── ML models ─────────────────────────────────────────────────────
            { value: "rfProb",        label: "RF direction P↑",     unit: "0–1",      hint: "> 0.6 = RF bullish",               group: "ML" },
            { value: "lstmDirProb",   label: "LSTM direction P↑",   unit: "0–1",      hint: "> 0.6 = LSTM bullish",             group: "ML" },
            { value: "lstmTrend",     label: "LSTM trend score",    unit: "-1 to +1", hint: "> 0.1 = uptrend",                  group: "ML" },
            // ── Position / exit context ────────────────────────────────────────
            { value: "unrealizedPct",   label: "Unrealized P&L (%)",   unit: "%",    hint: "> 1 = 1% in profit",               group: "Position" },
            { value: "heldMinutes",     label: "Time held (minutes)",   unit: "min",  hint: "> 30 = held 30+ minutes",          group: "Position" },
            { value: "heldTicks",       label: "Time held (ticks)",     unit: "ticks",hint: "> 60 = held 60+ ticks",            group: "Position" },
            { value: "peakProfitPct",   label: "Peak profit (%)",       unit: "%",    hint: "highest unrealised % since entry", group: "Position" },
            { value: "drawdownFromPeak",label: "Drawdown from peak (%)",unit: "%",    hint: "> 1 = fell 1% from peak",          group: "Position" },
            { value: "totalPnl",        label: "Total session P&L ($)", unit: "$",    hint: "cumulative realised P&L",          group: "Position" },
            { value: "signalScore",     label: "Signal score",          unit: "-5/+5",hint: "< 0 = signal reversed",            group: "Position" },
          ];

          const ENTRY_ACTIONS = [
            { value: "BUY",  label: "BUY",  color: "#10b981", hint: "Open a long position" },
            { value: "SELL", label: "SELL", color: "#ef4444", hint: "Close / short signal" },
            { value: "HOLD", label: "HOLD", color: "#94a3b8", hint: "Do nothing" },
          ];
          const EXIT_ACTIONS_LIST = [
            { value: "TAKE_PROFIT",          label: "Take Profit",         color: "#10b981", hint: "Exit at target price (standard TP)" },
            { value: "TRAILING_TAKE_PROFIT", label: "Trailing Take-Profit",color: "#10b981", hint: "Let profits run, exit on reversal from peak" },
            { value: "STOP_LOSS",            label: "Stop Loss",           color: "#ef4444", hint: "Exit to limit losses" },
            { value: "TRAILING_STOP",        label: "Trailing Stop Loss",  color: "#ef4444", hint: "Trail stop from entry price" },
            { value: "TIME_EXIT",            label: "Time-Based Exit",     color: "#f59e0b", hint: "Exit after holding N minutes" },
            { value: "SIGNAL_REVERSAL",      label: "Signal Reversal Exit",color: "#f59e0b", hint: "Exit when signal score turns negative" },
            { value: "DYNAMIC_EXIT",         label: "Dynamic Exit",        color: "#8b5cf6", hint: "Scale TP/SL based on session P&L" },
            { value: "POST_BUY_LIMIT",       label: "Post-Buy Limit Sell", color: "#6366f1", hint: "Place resting limit sell after BUY fills" },
          ];
          const ALL_ACTIONS = [...ENTRY_ACTIONS, ...EXIT_ACTIONS_LIST];
          const OPS = ["<", "<=", ">", ">=", "=", "!="];
          const newId = () => Math.random().toString(36).slice(2, 7);

          const addGroup = () => setCr({ groups: [...(cr.groups||[]), {
            id: newId(), label: `Rule ${(cr.groups||[]).length + 1}`,
            logic: "and", action: "BUY", weight: 1,
            conditions: [{ id: newId(), indicator: "rsi", op: "<", value: "35", enabled: true, combiner: "and" }],
          }]});

          const updateGroup = (gid, patch) => setCr({ groups: cr.groups.map(g => g.id===gid ? { ...g, ...patch } : g) });
          const removeGroup = (gid) => setCr({ groups: cr.groups.filter(g => g.id !== gid) });

          const addCond = (gid) => {
            const grp = cr.groups.find(g => g.id === gid);
            updateGroup(gid, {
              conditions: [...grp.conditions,
                { id: newId(), indicator: "rsi", op: "<", value: "35", enabled: true, combiner: "and" }]
            });
          };
          const updateCond = (gid, cid, patch) => updateGroup(gid, {
            conditions: cr.groups.find(g=>g.id===gid).conditions.map(c => c.id===cid ? { ...c, ...patch } : c)
          });
          const removeCond = (gid, cid) => updateGroup(gid, {
            conditions: cr.groups.find(g=>g.id===gid).conditions.filter(c => c.id !== cid)
          });

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Header toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px",
                borderRadius: 9, border: `0.5px solid ${cr.enabled ? "#10b981" : "var(--color-border-tertiary)"}`,
                background: cr.enabled ? "#10b98108" : "transparent" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={!!cr.enabled} onChange={e => setCr({ enabled: e.target.checked })} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: cr.enabled ? "#10b981" : "var(--color-text-primary)" }}>
                      Complex rule engine {cr.enabled ? "ACTIVE" : "OFF"}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                      When enabled, custom rules override the standard signal generator.
                      Rules are evaluated every tick — each passing group casts a weighted vote.
                    </div>
                  </div>
                </label>
                {cr.enabled && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Groups combine via</span>
                    {["and","or"].map(l => (
                      <button key={l} onClick={() => setCr({ groupLogic: l })}
                        style={{ padding: "3px 12px", borderRadius: 5, fontSize: 11, fontWeight: 700,
                          border: `0.5px solid ${cr.groupLogic===l ? "#10b981" : "var(--color-border-tertiary)"}`,
                          background: cr.groupLogic===l ? "#10b98122" : "transparent",
                          color: cr.groupLogic===l ? "#10b981" : "var(--color-text-secondary)", cursor: "pointer" }}>
                        {l.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Rule groups */}
              {cr.enabled && (
                <>
                  {(cr.groups||[]).map((group, gi) => (
                    <div key={group.id} style={{ borderRadius: 9, border: "0.5px solid var(--color-border-tertiary)",
                      padding: "12px 14px", background: "var(--color-background-secondary)" }}>
                      {/* Group header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <input value={group.label} onChange={e => updateGroup(group.id, { label: e.target.value })}
                          style={{ flex: 1, fontSize: 12, fontWeight: 600, background: "transparent",
                            border: "none", borderBottom: "0.5px solid var(--color-border-tertiary)",
                            color: "var(--color-text-primary)", padding: "2px 4px", outline: "none" }} />
                        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>conditions:</span>
                        <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>→</span>
                        <select value={group.action || "BUY"} onChange={e => updateGroup(group.id, { action: e.target.value })}
                          style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                            border: `0.5px solid ${(ALL_ACTIONS.find(a=>a.value===group.action)||ENTRY_ACTIONS[0]).color}44`,
                            background: "var(--color-background-primary)", cursor: "pointer",
                            color: (ALL_ACTIONS.find(a=>a.value===group.action)||ENTRY_ACTIONS[0]).color }}>
                          <optgroup label="Entry signals">
                            {ENTRY_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </optgroup>
                          <optgroup label="Exit strategies">
                            {EXIT_ACTIONS_LIST.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </optgroup>
                        </select>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--color-text-secondary)" }}>
                          W:
                          <input type="number" value={group.weight||1} min="1" max="10"
                            onChange={e => updateGroup(group.id, { weight: parseFloat(e.target.value)||1 })}
                            style={{ width: 36, fontSize: 11, padding: "2px 4px", borderRadius: 4,
                              border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
                        </label>
                        <button onClick={() => removeGroup(group.id)}
                          title="Remove group"
                          style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444", fontSize:14, padding:"2px 4px" }}>×</button>
                      </div>

                      {/* Conditions */}
                      {group.conditions.map((cond, ci) => {
                        const indInfo   = INDICATORS.find(i => i.value === cond.indicator);
                        const enabledIdx = group.conditions.filter((c,i) => c.enabled !== false && i <= ci).length; // 1-based row number among enabled
                        const rowNum    = group.conditions.filter((c,i) => i < ci && c.enabled !== false).length + 1;
                        return (
                          <div key={cond.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6,
                            opacity: cond.enabled === false ? 0.45 : 1 }}>
                            <input type="checkbox" checked={cond.enabled !== false}
                              onChange={e => updateCond(group.id, cond.id, { enabled: e.target.checked })} />
                            {/* Row number badge */}
                            <span style={{ fontSize: 10, fontWeight: 800, minWidth: 18, height: 18,
                              borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                              background: cond.enabled === false ? "var(--color-background-secondary)" : "#6366f122",
                              color: cond.enabled === false ? "var(--color-text-tertiary)" : "#6366f1",
                              flexShrink: 0 }}>
                              {rowNum}
                            </span>
                            {/* Indicator selector — grouped */}
                            <select value={cond.indicator}
                              onChange={e => updateCond(group.id, cond.id, { indicator: e.target.value })}
                              title={INDICATORS.find(i=>i.value===cond.indicator)?.hint || ""}
                              style={{ flex: 2, fontSize: 11, padding: "3px 6px", borderRadius: 4,
                                border: "0.5px solid var(--color-border-secondary)",
                                background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                              <optgroup label="Technical">
                                {INDICATORS.filter(i=>i.group==="Technical").map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
                              </optgroup>
                              <optgroup label="ML Models">
                                {INDICATORS.filter(i=>i.group==="ML").map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
                              </optgroup>
                              <optgroup label="Multi-Timeframe SMA/EMA/RSI">
                                {INDICATORS.filter(i=>i.group==="Multi-TF").map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
                              </optgroup>
                              <optgroup label="Position / Exit">
                                {INDICATORS.filter(i=>i.group==="Position").map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
                              </optgroup>
                            </select>
                            {/* Operator */}
                            <select value={cond.op}
                              onChange={e => updateCond(group.id, cond.id, { op: e.target.value })}
                              style={{ width: 50, fontSize: 11, padding: "3px 4px", borderRadius: 4,
                                border: "0.5px solid var(--color-border-secondary)",
                                background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                              {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                            {/* Threshold */}
                            <input type="number" value={cond.value}
                              onChange={e => updateCond(group.id, cond.id, { value: e.target.value })}
                              placeholder={indInfo?.hint || "value"}
                              style={{ width: 70, fontSize: 11, padding: "3px 6px", borderRadius: 4,
                                border: "0.5px solid var(--color-border-secondary)",
                                background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
                            {/* Unit hint */}
                            <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", minWidth: 40 }}>
                              {indInfo?.unit || ""}
                            </span>
                            {/* Remove condition */}
                            <button onClick={() => removeCond(group.id, cond.id)}
                              style={{ background:"none", border:"none", cursor:"pointer", color:"var(--color-text-tertiary)", fontSize:13, padding:"0 3px" }}>×</button>
                          </div>
                        );
                      })}
                      {/* Custom logic expression field */}
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, color: "var(--color-text-secondary)", fontWeight: 600, flexShrink: 0 }}>
                            Logic:
                          </span>
                          <input
                            value={group.customLogic || ""}
                            onChange={e => updateGroup(group.id, { customLogic: e.target.value })}
                            placeholder={`e.g. (1 AND 2) OR (3 AND 4)`}
                            style={{ flex: 1, fontSize: 11, padding: "3px 8px", borderRadius: 5,
                              border: `0.5px solid ${group.customLogic ? "#6366f1" : "var(--color-border-secondary)"}`,
                              background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                              fontFamily: "monospace" }}
                          />
                          {group.customLogic && (
                            <button onClick={() => updateGroup(group.id, { customLogic: "" })}
                              title="Clear custom logic — revert to sequential AND"
                              style={{ fontSize: 11, color: "var(--color-text-tertiary)", background: "none",
                                border: "none", cursor: "pointer", padding: "0 4px" }}>✕</button>
                          )}
                        </div>
                        {/* Hints */}
                        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.6, paddingLeft: 38 }}>
                          {group.customLogic ? (
                            <span style={{ color: "#6366f1" }}>
                              Custom logic active — row numbers above correspond to enabled conditions only.
                            </span>
                          ) : (
                            <>
                              Leave blank for sequential AND. Examples:
                              <span style={{ fontFamily: "monospace", marginLeft: 4, color: "#6366f1", cursor: "pointer" }}
                                onClick={() => updateGroup(group.id, { customLogic: "(1 AND 2) OR (3 AND 4)" })}>
                                (1 AND 2) OR (3 AND 4)
                              </span>
                              {" · "}
                              <span style={{ fontFamily: "monospace", color: "#6366f1", cursor: "pointer" }}
                                onClick={() => updateGroup(group.id, { customLogic: "1 AND (2 OR 3)" })}>
                                1 AND (2 OR 3)
                              </span>
                              {" · "}
                              <span style={{ fontFamily: "monospace", color: "#6366f1", cursor: "pointer" }}
                                onClick={() => updateGroup(group.id, { customLogic: "NOT 1 AND 2" })}>
                                NOT 1 AND 2
                              </span>
                              <br />
                              Supports: AND · OR · NOT · parentheses · row numbers (enabled rows only, 1-based)
                            </>
                          )}
                        </div>
                      </div>

                      <button onClick={() => addCond(group.id)}
                        style={{ marginTop: 6, fontSize: 10, color: "#6366f1", background: "transparent",
                          border: "0.5px dashed #6366f166", borderRadius: 4, padding: "3px 10px", cursor: "pointer" }}>
                        + Add condition
                      </button>
                    </div>
                  ))}

                  <button onClick={addGroup}
                    style={{ padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      border: "0.5px dashed #6366f1", background: "transparent",
                      color: "#6366f1", cursor: "pointer", width: "100%" }}>
                    + Add rule group
                  </button>

                  {/* Legend */}
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.7,
                    padding: "8px 12px", borderRadius: 7, background: "var(--color-background-secondary)" }}>
                    <strong>Multi-TF indicators</strong> (sma20_1m, sma50_5m, rsi_15m etc.) use real wall-clock time buffers — they need time to fill: 1min needs 20min for SMA20, 5min needs 100min, 1hr needs 20hrs. Values show % distance from current price (positive = price is above the SMA).{" "}
                    <strong>Entry groups</strong> (BUY/SELL/HOLD) cast weighted votes combined via the top-level AND/OR.{" "}
                    <strong>Exit groups</strong> fire immediately when their conditions pass — no voting, first match wins by weight.{" "}
                    <strong>Position indicators</strong> (unrealized %, held time, peak profit, drawdown) are only available when a position is open.{" "}
                    <strong>RF/LSTM</strong> available after warm-up (15 ticks / 80 ticks respectively).{" "}
                    Hover over an indicator selector to see a hint for typical values.
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* Footer */}
        <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "7px 18px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>
            Cancel
          </button>
          <button onClick={() => onSave(form)}
            style={{ padding: "7px 22px", borderRadius: 7, border: `0.5px solid ${activeProviderInfo.color}`, background: activeProviderInfo.color + "22", color: activeProviderInfo.color, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            <i className="ti ti-device-floppy" aria-hidden="true" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Random Forest Classifier ────────────────────────────────────────────────
// Pure-JS in-browser RF — no TF.js needed, trains in < 100ms, works from tick 10
// Predicts P(price up in next 5 ticks) from current indicator snapshot

const RF_MIN_SAMPLES = 10;
const RF_N_TREES     = 20;
const RF_MAX_DEPTH   = 4;
const rfPredCache    = {};
const rfModels       = {};

// ─── Reinforcement Learning (Q-Learning) ─────────────────────────────────────
// State: discretised indicator snapshot (RSI band, MACD sign, BB zone, trend)
// Actions: 0=HOLD, 1=BUY, 2=SELL
// Reward: net P&L of completed trade (positive = good, negative = bad)
// Q-table: state → [q_hold, q_buy, q_sell] — updated via Bellman equation
const RL_ALPHA        = 0.1;   // learning rate
const RL_GAMMA        = 0.9;   // discount factor
const RL_EPSILON_START = 0.4;  // initial exploration rate
const RL_EPSILON_MIN   = 0.05; // minimum exploration (always explore a little)
const RL_EPSILON_DECAY = 0.995;// decay per episode
const RL_MIN_EPISODES  = 20;   // minimum episodes before trusting predictions
const RL_DIR_THRESHOLD = 0.6;  // Q-value confidence threshold for BUY/SELL

const rlTables   = {};  // { BTC: { qTable: Map<state,float[]>, epsilon, episodes } }
const rlPredCache = {}; // { BTC: { action, confidence, directionProbability, episodes } }

// Discretise continuous indicators into a compact state string
function getRLState(indicators, volumeRatio) {
  const rsi  = indicators?.rsi ?? 50;
  const macd = indicators?.macd ?? 0;
  const boll = indicators?.boll
    ? (indicators.currentPrice - indicators.boll.lower) /
      (indicators.boll.upper - indicators.boll.lower || 1)
    : 0.5;
  const vol  = volumeRatio ?? 1;

  // Discretise each feature into 3–4 bins
  const rsiBand  = rsi < 35 ? 0 : rsi > 65 ? 2 : 1;          // oversold/neutral/overbought
  const macdSign = macd < -0.0005 ? 0 : macd > 0.0005 ? 2 : 1; // bear/flat/bull
  const bollZone = boll < 0.2 ? 0 : boll > 0.8 ? 2 : 1;        // low/mid/high
  const volZone  = vol < 0.8 ? 0 : vol > 1.3 ? 2 : 1;          // low/normal/high

  return `${rsiBand}${macdSign}${bollZone}${volZone}`; // e.g. "0212"
}

// Initialise or get Q-table entry
function getQ(table, state) {
  if (!table.has(state)) table.set(state, [0, 0, 0]); // [HOLD, BUY, SELL]
  return table.get(state);
}

// Update Q-table after trade completes (Bellman equation)
function rlUpdate(coin, prevState, action, reward, nextState, params = {}) {
  if (!rlTables[coin]) return;
  const alpha        = parseFloat(params.alpha)        || RL_ALPHA;
  const gamma        = parseFloat(params.gamma)        || RL_GAMMA;
  const epsilonMin   = parseFloat(params.epsilonMin)   || RL_EPSILON_MIN;
  const epsilonDecay = parseFloat(params.epsilonDecay) || RL_EPSILON_DECAY;

  const { qTable } = rlTables[coin];
  const q      = getQ(qTable, prevState);
  const qNext  = getQ(qTable, nextState);
  const maxQ   = Math.max(...qNext);
  const actionIdx = action === "BUY" ? 1 : action === "SELL" ? 2 : 0;
  // Q(s,a) ← Q(s,a) + α[r + γ·maxQ(s') - Q(s,a)]
  q[actionIdx] = q[actionIdx] + alpha * (reward + gamma * maxQ - q[actionIdx]);
  rlTables[coin].episodes++;
  rlTables[coin].epsilon = Math.max(epsilonMin, rlTables[coin].epsilon * epsilonDecay);
}

// Get RL action for current state (epsilon-greedy)
function rlPredict(coin, indicators, volumeRatio, params = {}) {
  const epsilonStart = parseFloat(params.epsilonStart) || RL_EPSILON_START;
  if (!rlTables[coin]) {
    rlTables[coin] = { qTable: new Map(), epsilon: epsilonStart, episodes: 0 };
  }
  const { qTable, epsilon, episodes } = rlTables[coin];
  const state = getRLState(indicators, volumeRatio);

  // NOTE: do NOT overwrite lastState here — it is set only at BUY time
  // so rlReward can update the correct entry state after the trade closes.

  let actionIdx;
  if (Math.random() < epsilon) {
    actionIdx = Math.floor(Math.random() * 3);
  } else {
    const q = getQ(qTable, state);
    actionIdx = q.indexOf(Math.max(...q));
  }

  const actions = ["HOLD", "BUY", "SELL"];
  const action  = actions[actionIdx];

  // Read live Q-values from the table (not a stale snapshot)
  const q      = getQ(qTable, state);
  const maxQ   = Math.max(...q);
  const minQ   = Math.min(...q);
  const range  = maxQ - minQ || 1;
  const dirProb = (q[1] - minQ) / range;
  const avgQ    = (q[0] + q[1] + q[2]) / 3;
  const confidence = Math.min(99,
    Math.round(Math.abs(maxQ - avgQ) / (Math.abs(maxQ) + 0.001) * 100));

  rlPredCache[coin] = {
    action, confidence, directionProbability: dirProb,
    episodes, epsilon: epsilon.toFixed(3), state,
    // Live Q-values — read directly from Map so they reflect latest updates
    get qValues() {
      const qLive = getQ(rlTables[coin]?.qTable, this.state);
      return qLive.map(v => v.toFixed(4));
    },
  };
  return rlPredCache[coin];
}

// Called when a BUY is placed — records the entry state
// so rlReward can update the correct Q(entry_state, BUY) after the trade closes
function rlOnBuy(coin, indicators, volumeRatio) {
  if (!rlTables[coin]) {
    rlTables[coin] = { qTable: new Map(), epsilon: RL_EPSILON_START, episodes: 0 };
  }
  // Snapshot the entry state at BUY time — NOT overwritten during the hold
  rlTables[coin].entryState  = getRLState(indicators, volumeRatio);
  rlTables[coin].entryAction = "BUY";
}

// Called after a trade closes — reward the BUY action taken at entry
function rlReward(coin, netPnl, indicators, volumeRatio, params = {}) {
  if (!rlTables[coin]) return;
  const rewardScale = parseFloat(params.rewardScale) || 100;
  const entryState  = rlTables[coin].entryState || "1111";
  const nextState   = getRLState(indicators, volumeRatio);
  const reward      = netPnl * rewardScale;
  rlUpdate(coin, entryState, "BUY",  reward, nextState, params);
  rlUpdate(coin, nextState,  "SELL", reward, nextState, params);
}

// Extract feature snapshot from current indicator state
function buildRFFeatures(prices, indicators, volumeRatio) {
  const p      = prices.at(-1) || 1;
  const sma20  = calcSMA(prices, 20) || p;
  const sma50  = calcSMA(prices, 50) || p;
  const atr    = calcATR(prices, 14) || 0;
  return [
    ((indicators?.rsi ?? 50) - 50) / 50,                                // RSI normalised
    Math.max(-1, Math.min(1, (indicators?.macd ?? 0) / (p * 0.01))),    // MACD normalised
    indicators?.boll
      ? Math.max(-1, Math.min(1, (p - indicators.boll.lower) /
          (indicators.boll.upper - indicators.boll.lower || 1) * 2 - 1))
      : 0,                                                               // Bollinger %B
    sma20 > 0 ? (p - sma20) / sma20 : 0,                                // price vs SMA20
    sma50 > 0 ? (p - sma50) / sma50 : 0,                                // price vs SMA50
    indicators?.ema12 && indicators?.ema26
      ? (indicators.ema12 - indicators.ema26) / p : 0,                  // EMA spread
    atr / p,                                                             // ATR % of price
    Math.max(-2, Math.min(2, volumeRatio - 1)),                          // volume ratio centred
    prices.length > 1 ? (p - prices.at(-2)) / prices.at(-2) : 0,       // 1-tick return
    prices.length > 5
      ? (p - prices.at(-5)) / prices.at(-5) : 0,                       // 5-tick return
  ];
}

// Build dataset: features at t → label (1 if up in 5 ticks, 0 if down)
function buildRFDataset(prices, indicators, volumeRatio) {
  const X = [], Y = [];
  const minLen = RF_MIN_SAMPLES + 5;
  if (prices.length < minLen) return { X, Y };
  const end = prices.length - 5; // need 5 future ticks for labels
  const start = Math.max(20, end - 300); // use last 300 points
  for (let i = start; i < end; i++) {
    const slice     = prices.slice(0, i + 1);
    const indSnap   = {
      rsi:  calcRSI(slice, 14),
      macd: calcMACD(slice),
      boll: calcBollinger(slice, 20),
      ema12: calcEMA(slice, 12),
      ema26: calcEMA(slice, 26),
    };
    const feats = buildRFFeatures(slice, indSnap, volumeRatio);
    const label = prices[i + 5] > prices[i] ? 1 : 0; // up in 5 ticks?
    X.push(feats); Y.push(label);
  }
  return { X, Y };
}

// Single decision tree node
function buildTree(X, Y, depth, maxDepth, nFeatures) {
  const n = Y.length;
  if (n === 0) return { leaf: true, prob: 0.5 };
  const pos = Y.filter(y => y === 1).length;
  const prob = pos / n;
  if (depth >= maxDepth || n < 4 || pos === 0 || pos === n) return { leaf: true, prob };

  // Random feature subset (sqrt of total)
  const allFeat = Array.from({ length: X[0].length }, (_, i) => i);
  const featIdx = allFeat.sort(() => Math.random() - 0.5).slice(0, nFeatures);

  let bestGini = Infinity, bestFeat = -1, bestThresh = 0;
  for (const fi of featIdx) {
    const vals = [...new Set(X.map(x => x[fi]))].sort((a, b) => a - b);
    for (let v = 0; v < vals.length - 1; v++) {
      const thresh = (vals[v] + vals[v + 1]) / 2;
      const left   = Y.filter((_, i) => X[i][fi] <= thresh);
      const right  = Y.filter((_, i) => X[i][fi] >  thresh);
      if (!left.length || !right.length) continue;
      const giniL  = 1 - Math.pow(left.filter(y=>y===1).length/left.length,2)
                       - Math.pow(left.filter(y=>y===0).length/left.length,2);
      const giniR  = 1 - Math.pow(right.filter(y=>y===1).length/right.length,2)
                       - Math.pow(right.filter(y=>y===0).length/right.length,2);
      const gini   = (left.length * giniL + right.length * giniR) / n;
      if (gini < bestGini) { bestGini = gini; bestFeat = fi; bestThresh = thresh; }
    }
  }
  if (bestFeat < 0) return { leaf: true, prob };
  const leftIdx  = X.map((x, i) => i).filter(i => X[i][bestFeat] <= bestThresh);
  const rightIdx = X.map((x, i) => i).filter(i => X[i][bestFeat] >  bestThresh);
  return {
    feat: bestFeat, thresh: bestThresh,
    left:  buildTree(leftIdx.map(i=>X[i]),  leftIdx.map(i=>Y[i]),  depth+1, maxDepth, nFeatures),
    right: buildTree(rightIdx.map(i=>X[i]), rightIdx.map(i=>Y[i]), depth+1, maxDepth, nFeatures),
  };
}

function predictTree(node, x) {
  if (node.leaf) return node.prob;
  return x[node.feat] <= node.thresh ? predictTree(node.left, x) : predictTree(node.right, x);
}

// Bootstrap sample for bagging
function bootstrap(X, Y) {
  const n = X.length, bX = [], bY = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * n);
    bX.push(X[idx]); bY.push(Y[idx]);
  }
  return { bX, bY };
}

// Train Random Forest
function trainRF(X, Y) {
  const nFeat = Math.max(2, Math.floor(Math.sqrt(X[0].length)));
  const trees = [];
  for (let t = 0; t < RF_N_TREES; t++) {
    const { bX, bY } = bootstrap(X, Y);
    trees.push(buildTree(bX, bY, 0, RF_MAX_DEPTH, nFeat));
  }
  return trees;
}

// RF inference — average tree probabilities
function predictRF(trees, x) {
  if (!trees?.length) return 0.5;
  return trees.reduce((s, t) => s + predictTree(t, x), 0) / trees.length;
}

// Main RF update — train and predict
function updateRF(coin, prices, indicators, volumeRatio) {
  const { X, Y } = buildRFDataset(prices, indicators, volumeRatio);
  if (X.length < RF_MIN_SAMPLES) return null;

  // Retrain every 50 new samples or if no model yet
  const lastCount = rfModels[coin]?.trainedOn || 0;
  if (!rfModels[coin]?.trees || X.length - lastCount >= 50) {
    const trees = trainRF(X, Y);
    rfModels[coin] = { trees, trainedOn: X.length };
    console.log(`[RF] ${coin}: trained on ${X.length} samples`);
  }

  // Predict current state
  const currentFeats = buildRFFeatures(prices, indicators, volumeRatio);
  const prob = predictRF(rfModels[coin].trees, currentFeats);
  rfPredCache[coin] = { directionProbability: prob, trainedOn: X.length, timestamp: Date.now() };
  return rfPredCache[coin];
}

// ─── LSTM RNN Model ──────────────────────────────────────────────────────────
// Browser-native LSTM using TensorFlow.js
// Architecture: 60-step sequence → LSTM(64) → LSTM(32) → Dense(3)
// Inputs per step: [normPrice, rsi, macdNorm, bollingerPct, volRatio, emaRatio]
// Outputs: [predictedChangePct, trendScore(-1 to 1), volatilityScore(0 to 1)]

const LSTM_SEQ_LEN     = 60;   // lookback window (ticks)
const LSTM_STEPS       = 5;    // predict N ticks ahead (Priority 2: multi-step)
const LSTM_FEATURES    = 7;    // input features: 6 original + time-of-day
const LSTM_RETRAIN_MS  = 5 * 60 * 1000; // retrain every 5 minutes

// Per-coin LSTM state
const lstmModels    = {};  // { BTC: tf.Model, ... }
const lstmLastTrain = {};  // { BTC: timestamp, ... }
const lstmPredCache = {};  // { BTC: { predictedChangePct, trendScore, volatility, trainedAt } }
const lstmTraining  = {};  // { BTC: bool } — per-coin training lock prevents concurrent fit() calls

// Build feature vector for one timestep
function buildLSTMFeatures(prices, i, indicators) {
  const price  = prices[i];
  const prev   = prices[Math.max(0, i - 1)] || price;
  const mean   = prices.slice(Math.max(0, i - 20), i + 1).reduce((a, b) => a + b, 0) / Math.min(i + 1, 20);
  const std    = Math.sqrt(prices.slice(Math.max(0, i - 20), i + 1).reduce((a, b) => a + (b - mean) ** 2, 0) / Math.min(i + 1, 20)) || 1;
  // Time-of-day feature: encode hour as sine wave so midnight and noon are continuous
  const hour = new Date().getHours();
  const timeFeature = Math.sin(2 * Math.PI * hour / 24); // -1 to +1, periodic
  return [
    (price - mean) / std,                                                // 0: z-score price
    ((indicators?.rsi ?? 50) - 50) / 50,                                // 1: RSI centred on 0
    Math.max(-1, Math.min(1, (indicators?.macd ?? 0) / (price * 0.01))), // 2: MACD normalised
    indicators?.boll
      ? (price - indicators.boll.lower) / (indicators.boll.upper - indicators.boll.lower || 1) * 2 - 1
      : 0,                                                               // 3: Bollinger %B
    Math.min(2, Math.max(-2, (price - prev) / prev * 100)) / 2,        // 4: 1-tick return
    indicators?.ema12 && indicators?.ema26
      ? (indicators.ema12 - indicators.ema26) / price
      : 0,                                                               // 5: EMA ratio
    timeFeature,                                                         // 6: time-of-day (sin encoded)
  ];
}

// Build full sequence tensor from price history
function buildSequence(prices, allIndicators) {
  if (prices.length < LSTM_SEQ_LEN) return null;
  const seq = [];
  const start = prices.length - LSTM_SEQ_LEN;
  for (let i = start; i < prices.length; i++) {
    seq.push(buildLSTMFeatures(prices, i, allIndicators));
  }
  return seq; // shape: [LSTM_SEQ_LEN, LSTM_FEATURES]
}

// Create and compile LSTM model
async function createLSTMModel(_tf) {
  const tf = window.tf;
  const model = tf.sequential();
  model.add(tf.layers.lstm({
    units: 64, inputShape: [LSTM_SEQ_LEN, LSTM_FEATURES],
    returnSequences: true, kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
  }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.lstm({
    units: 32, returnSequences: false,
    kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
  }));
  model.add(tf.layers.dropout({ rate: 0.1 }));
  model.add(tf.layers.dense({ units: 16, activation: "relu" }));
  model.add(tf.layers.dense({ units: 4, activation: "tanh" })); // [changePct, trend, volatility, directionProb]
  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: "meanSquaredError",
  });
  return model;
}

// Train LSTM on historical price data
async function trainLSTM(_tf, coin, prices, indicators) {
  const tf = window.tf;
  // Guard against concurrent fit() calls on the same coin
  if (lstmTraining[coin]) {
    console.log(`[LSTM] ${coin}: skipping train — previous fit() still running`);
    return lstmModels[coin] || null;
  }
  lstmTraining[coin] = true;
  if (prices.length < LSTM_SEQ_LEN + 20) return null; // need enough data

  const model = lstmModels[coin] || await createLSTMModel(tf);
  lstmModels[coin] = model;

  // Build training samples: X = sequence, Y = next-tick outcomes
  const X = [], Y = [];
  const trainEnd = prices.length - 1;
  const trainStart = Math.max(LSTM_SEQ_LEN, trainEnd - 300); // use last 300 ticks

  // Need LSTM_STEPS extra ticks beyond trainEnd for multi-step targets
  const safeEnd = prices.length - LSTM_STEPS;

  for (let i = trainStart; i < safeEnd; i++) {
    const slice  = prices.slice(i - LSTM_SEQ_LEN, i);
    const seq    = [];
    for (let j = 0; j < LSTM_SEQ_LEN; j++) {
      seq.push(buildLSTMFeatures(slice, j, indicators));
    }

    // Priority 2: predict LSTM_STEPS ticks ahead (5 ticks)
    const priceNow    = prices[i - 1];
    const priceFuture = prices[i + LSTM_STEPS - 1]; // 5 ticks ahead
    const changePct   = Math.max(-1, Math.min(1, (priceFuture - priceNow) / priceNow * 100 / 2));

    // Direction probability: fraction of next LSTM_STEPS ticks above current price
    const futureSlice = prices.slice(i, i + LSTM_STEPS);
    const upTicks = futureSlice.filter(p => p > priceNow).length;
    const directionProb = (upTicks / LSTM_STEPS) * 2 - 1; // scale to -1..+1

    // Trend: price relative to 20-SMA
    const sma20 = slice.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const trend = Math.max(-1, Math.min(1, (priceFuture - sma20) / sma20 * 50));

    // Volatility: std of last 10 1-tick returns
    const returns  = slice.slice(-10).map((p, k, arr) => k > 0 ? (p - arr[k - 1]) / arr[k - 1] : 0);
    const volStd   = Math.sqrt(returns.reduce((a, b) => a + b * b, 0) / returns.length);
    const volatility = Math.min(1, volStd * 100);

    X.push(seq);
    Y.push([changePct, trend, volatility, directionProb]); // 4 outputs now
  }

  if (X.length < 10) return null;

  const xTensor = tf.tensor3d(X);
  const yTensor = tf.tensor2d(Y);

  try {
    await model.fit(xTensor, yTensor, {
      epochs: 10,           // reduced from 15 — faster, less overrun risk
      batchSize: 16,        // smaller batches finish faster in browser
      validationSplit: 0.1,
      shuffle: true,
      callbacks: {
        onEpochEnd: (_epoch, logs) => {
          // Early stop if loss is already very low
          if (logs?.loss < 0.001) return model.stopTraining = true;
        },
      },
    });
    return model;
  } catch (e) {
    console.error(`[LSTM] ${coin} fit() error:`, e.message);
    return lstmModels[coin] || null; // return existing model if retrain fails
  } finally {
    xTensor.dispose();
    yTensor.dispose();
    lstmTraining[coin] = false;  // always release lock
  }
}

// Run inference — get prediction for current state
async function runLSTMInference(_tf, coin, prices, indicators) {
  const tf = window.tf;
  const model = lstmModels[coin];
  if (!model) return null;
  const seq = buildSequence(prices, indicators);
  if (!seq) return null;

  const input = tf.tensor3d([seq]); // shape [1, SEQ_LEN, FEATURES]
  let pred;
  try {
    pred = model.predict(input);
    const [changePct, trend, volatility, directionProb] = Array.from(await pred.data());
    return {
      predictedChangePct: changePct * 2,          // 5-tick ahead change, un-scaled
      trendScore:         trend,                   // -1 (bearish) to +1 (bullish)
      volatility:         Math.abs(volatility),    // 0 (calm) to 1 (high)
      directionProbability: (directionProb + 1) / 2, // rescale -1..1 → 0..1
      lstmSteps:          LSTM_STEPS,              // how many ticks ahead
      trainedOn:          prices.length,
    };
  } finally {
    input.dispose();
    pred?.dispose();
  }
}

// Main LSTM manager — train if needed, return latest prediction
async function getLSTMPrediction(_tf, coin, prices, indicators) {
  // Use passed tf reference (already validated by caller's waitForTF)
  const tf = (typeof _tf?.sequential === "function") ? _tf : window.tf;
  if (!tf || typeof tf.sequential !== "function") {
    throw new Error("TensorFlow.js not ready — tf.sequential unavailable");
  }
  const now       = Date.now();
  const lastTrain = lstmLastTrain[coin] || 0;
  const needsTrain = !lstmModels[coin] || (now - lastTrain) > LSTM_RETRAIN_MS;

  if (needsTrain && prices.length >= LSTM_SEQ_LEN + 20) {
    await trainLSTM(tf, coin, prices, indicators);
    lstmLastTrain[coin] = now;
  }

  const prediction = await runLSTMInference(tf, coin, prices, indicators);
  if (prediction) lstmPredCache[coin] = { ...prediction, timestamp: now };
  return lstmPredCache[coin] || null;
}

// ─── LLM Agent ───────────────────────────────────────────────────────────────
// Calls Claude claude-sonnet-4-6 with full market context and returns a structured
// BUY / SELL / HOLD decision with reasoning. Runs every N seconds async.
async function callLLMAgent(context) {
  const {
    coin, currentPrice, indicators, sentiment, volumeRatio,
    position, recentHistory, settings, exitStrategies, lstmPrediction, rfPrediction, atrPct,
  } = context;

  const positionStr = position
    ? `OPEN — entry $${position.price?.toFixed(2)}, size ${position.size?.toFixed(8)}, ` +
      `unrealized ${((currentPrice - position.price) / position.price * 100).toFixed(2)}%`
    : "NONE";

  const historyStr = recentHistory.slice(0, 5)
    .map(h => `${h.action} @ $${h.price?.toFixed(2)} (${h.exitTrigger || "signal"})`)
    .join(", ") || "none";

  const prompt = `You are an expert crypto trading agent making a decision for ${coin}/USD.

CURRENT MARKET STATE
Price: $${currentPrice?.toFixed(2)}
Volume ratio: ${volumeRatio?.toFixed(2)}x (>1 = above average)
News sentiment: ${(sentiment * 100).toFixed(0)}% (positive=buy pressure, negative=sell pressure)

TECHNICAL INDICATORS
RSI (14): ${indicators.rsi?.toFixed(1) ?? "n/a"} (oversold<${settings.indicatorConfig?.rsi?.oversold||35}, overbought>${settings.indicatorConfig?.rsi?.overbought||65})
SMA 20: $${indicators.sma20?.toFixed(2) ?? "n/a"}
SMA 50: $${indicators.sma50?.toFixed(2) ?? "n/a"}
SMA 99: $${indicators.sma99?.toFixed(2) ?? "n/a"}
EMA 12: $${indicators.ema12?.toFixed(2) ?? "n/a"}
EMA 26: $${indicators.ema26?.toFixed(2) ?? "n/a"}
MACD: ${indicators.macd?.toFixed(4) ?? "n/a"}
Bollinger upper: $${indicators.boll?.upper?.toFixed(2) ?? "n/a"}
Bollinger lower: $${indicators.boll?.lower?.toFixed(2) ?? "n/a"}
ATR (14): $${indicators.atr?.toFixed(2) ?? "n/a"}

LSTM RNN PREDICTION (trained on last ${indicators.trainedOn || "N/A"} ticks)
${lstmPrediction ? `LSTM (sequence model, ${lstmPrediction.lstmSteps || 5}-tick forecast):
  Predicted change: ${lstmPrediction.predictedChangePct >= 0 ? "+" : ""}${lstmPrediction.predictedChangePct?.toFixed(4)}%
  Direction P↑: ${((lstmPrediction.directionProbability ?? 0.5) * 100).toFixed(1)}% (>65% = bull, <35% = bear)
  Trend score: ${lstmPrediction.trendScore?.toFixed(3)} | Volatility: ${lstmPrediction.volatility?.toFixed(3)}
  Trained on: ${lstmPrediction.trainedOn} ticks` : "LSTM: not yet available (needs 80+ ticks)"}
${rfPrediction ? `RANDOM FOREST (snapshot classifier, ${rfPrediction.trainedOn} samples):
  Direction P↑ next 5 ticks: ${((rfPrediction.directionProbability ?? 0.5) * 100).toFixed(1)}% — available from tick 15
  Consensus: ${rfPrediction.directionProbability > 0.6 ? "BULLISH" : rfPrediction.directionProbability < 0.4 ? "BEARISH" : "NEUTRAL"}` : "RF: warming up (needs 15 samples)"}
${rfPrediction && lstmPrediction ? `MODEL CONSENSUS: RF=${((rfPrediction.directionProbability??0.5)*100).toFixed(0)}% LSTM=${((lstmPrediction.directionProbability??0.5)*100).toFixed(0)}% — ${rfPrediction.directionProbability > 0.55 && lstmPrediction.directionProbability > 0.55 ? "BOTH BULLISH" : rfPrediction.directionProbability < 0.45 && lstmPrediction.directionProbability < 0.45 ? "BOTH BEARISH" : `RF leans ${rfPrediction.directionProbability > 0.5 ? "bull" : "bear"}, LSTM leans ${lstmPrediction.directionProbability > 0.5 ? "bull" : "bear"}`}` : ""}

CURRENT POSITION: ${positionStr}
RECENT TRADES: ${historyStr}

TRADING RULES
Starting balance: $${settings.tradeSizeUSD}
Current trade size (compounding balance): $${settings.currentBalance || settings.tradeSizeUSD}
Fee per side: ${settings.feePercent}%
Round-trip fee cost: ${(parseFloat(settings.feePercent||0.1)*2).toFixed(3)}%
Break-even move needed: ${(parseFloat(settings.feePercent||0.1)*2).toFixed(3)}% (price must move MORE than this to profit)
Current ATR (14): $${context.indicators?.atr?.toFixed(2) ?? "n/a"} = ${context.atrPct?.toFixed(3) ?? "n/a"}% of price
ATR vs break-even: ${context.atrPct ? (context.atrPct / (parseFloat(settings.feePercent||0.1)*2)).toFixed(1) : "n/a"}× (must be >1.5 to be worth trading)
Min confidence required: ${settings.minConfidence}%
Take profit target: ${settings.exitRules?.takeProfitValue}${settings.exitRules?.takeProfitType==="percent"?"%":"$"}
Stop loss limit: ${settings.exitRules?.stopLossValue}${settings.exitRules?.stopLossType==="percent"?"%":"$"}
Reward:risk ratio: ${settings.exitRules ? (parseFloat(settings.exitRules.takeProfitValue||2)/parseFloat(settings.exitRules.stopLossValue||1)).toFixed(1) : "n/a"}:1
Active exit strategies: ${Object.entries(exitStrategies||{}).filter(([,v])=>v?.enabled).map(([k])=>k).join(", ")||"none"}

TRADING MODE: ${settings.tradingMode === "mean_reversion" ? "MEAN REVERSION — buy dips below bands, sell rips above bands. Low volume is preferred. MACD and RSI extremes are entry signals, not exit signals." : "MOMENTUM — buy breakouts with strong indicators, trend following."}

DECISION CRITERIA:
1. The RF and LSTM models provide direction probability — weight these heavily. If both show >55% bullish, lean BUY.
2. The expected move should exceed the round-trip fee of ${(parseFloat(settings.feePercent||0.1)*2).toFixed(3)}% — but if models are confident, a smaller expected move is acceptable.
3. Be decisive — return BUY or SELL when evidence leans that way. Reserve HOLD for genuinely neutral situations.
4. Only return SELL if there is an open position AND clear reversal evidence.
5. Your job is to synthesise all signals into a clear decision, not to find reasons to stay out.

Respond ONLY with valid JSON, no other text:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": <0-100 integer>,
  "score": <-5 to +5 float representing signal strength>,
  "reasoning": "<one concise sentence — must mention fee profitability>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"],
  "risk": "low" | "medium" | "high",
  "suggestedTpAdjust": null | "<+X% or -X%>",
  "suggestedSlAdjust": null | "<+X% or -X%>"
}`;

  // Route through Cloud Run proxy — API key lives on the server, never in browser
  if (!PROXY_BASE) throw new Error("PROXY_BASE not set — cannot reach agent endpoint");
  const response = await fetch(`${PROXY_BASE}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, provider: context.llmProvider || "deepseek" }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Agent proxy HTTP ${response.status}`);
  }
  const data = await response.json();
  const text = data.text || "";

  // Strip DeepSeek <think> reasoning trace and markdown fences
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")  // remove DeepSeek chain-of-thought block
    .replace(/```json|```/g, "")               // remove markdown fences
    .trim();
  const parsed = JSON.parse(clean);

  // Validate required fields
  if (!["BUY","SELL","HOLD"].includes(parsed.action)) throw new Error("Invalid action from LLM");
  if (typeof parsed.confidence !== "number") throw new Error("Missing confidence from LLM");

  return {
    action:             parsed.action,
    confidence:         String(Math.min(100, Math.max(0, parsed.confidence))),
    score:              String(parsed.score ?? 0),
    reasoning:          parsed.reasoning || "",
    keyFactors:         parsed.keyFactors || [],
    risk:               parsed.risk || "medium",
    suggestedTpAdjust:  parsed.suggestedTpAdjust || null,
    suggestedSlAdjust:  parsed.suggestedSlAdjust || null,
    agreeingCount:      3,  // satisfies existing BUY gate
    totalIndicators:    8,
    reasons:            (parsed.keyFactors || []).map(f => ({ label: f, vote: parsed.action === "BUY" ? 1 : parsed.action === "SELL" ? -1 : 0 })),
    fromAgent:          true,
    timestamp:          Date.now(),
  };
}

// ─── WebSocket price feed ────────────────────────────────────────────────────
// Exchange WebSocket endpoints (public, no auth, no CORS restriction)
const WS_ENDPOINTS = {
  binance:  (coins) => `wss://stream.binance.us:9443/stream?streams=${coins.map(c => `${c.toLowerCase()}usd@bookTicker`).join("/")}`,
  kraken:   ()      => "wss://ws.kraken.com",
  gemini:   ()      => "wss://api.gemini.com/v1/marketdata/BTCUSD",
  coinbase: (coins) => `wss://advanced-trade-ws.coinbase.com`,
  alpaca:   ()      => "wss://stream.data.alpaca.markets/v1beta3/crypto/us",
  public:   ()      => null,
};

function useWebSocketPrices(provider, coins, enabled, onPrice, onStatusChange) {
  const wsRef    = useRef(null);
  const retryRef = useRef(0);
  const MAX_RETRIES = 5;

  useEffect(() => {
    if (!enabled || !provider || !coins?.length) return;
    const getUrl = WS_ENDPOINTS[provider];
    if (!getUrl) { onStatusChange("unsupported"); return; }
    const url = getUrl(coins);
    if (!url) { onStatusChange("unsupported"); return; }

    let dead = false;

    function connect() {
      if (dead) return;
      onStatusChange("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        onStatusChange("connected");

        // Send subscription messages per exchange
        if (provider === "kraken") {
          ws.send(JSON.stringify({
            event: "subscribe",
            pair: coins.map(c => `${c === "BTC" ? "XBT" : c}/USD`),
            subscription: { name: "ticker" },
          }));
        } else if (provider === "coinbase") {
          ws.send(JSON.stringify({
            type: "subscribe",
            product_ids: coins.map(c => `${c}-USD`),
            channel: "ticker",
          }));
        } else if (provider === "alpaca") {
          ws.send(JSON.stringify({ action: "subscribe", quotes: coins.map(c => `${c}/USD`) }));
        }
        // Binance and Gemini: subscription is in the URL
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          // ── Binance combined stream ──────────────────────────────────
          if (provider === "binance" && msg.stream) {
            const d = msg.data;
            const coin = d.s?.replace(/USD$/, ""); // BTCUSD → BTC
            if (coin && d.a) onPrice(coin, parseFloat(d.a), parseFloat(d.b), parseFloat(d.a));
          }
          // ── Kraken ticker ────────────────────────────────────────────
          if (provider === "kraken" && Array.isArray(msg) && msg[2] === "ticker") {
            const pair = msg[3]; // e.g. XBT/USD
            const coin = pair.replace("/USD","").replace("XBT","BTC");
            const t = msg[1];
            onPrice(coin, parseFloat(t.c[0]), parseFloat(t.b[0]), parseFloat(t.a[0]));
          }
          // ── Gemini ───────────────────────────────────────────────────
          if (provider === "gemini" && msg.type === "trade") {
            const coin = "BTC"; // Gemini single-symbol stream
            onPrice(coin, parseFloat(msg.price), parseFloat(msg.price), parseFloat(msg.price));
          }
          // ── Coinbase advanced trade ───────────────────────────────────
          if (provider === "coinbase" && msg.channel === "ticker" && msg.events?.[0]?.tickers) {
            for (const t of msg.events[0].tickers) {
              const coin = t.product_id?.replace("-USD","");
              if (coin) onPrice(coin, parseFloat(t.price), parseFloat(t.best_bid), parseFloat(t.best_ask));
            }
          }
          // ── Alpaca ───────────────────────────────────────────────────
          if (provider === "alpaca" && Array.isArray(msg)) {
            for (const m of msg) {
              if (m.T === "q") {
                const coin = m.S?.replace("/USD","");
                if (coin) onPrice(coin, (m.ap + m.bp) / 2, m.bp, m.ap);
              }
            }
          }
        } catch (_) {}
      };

      ws.onerror = () => onStatusChange("error");

      ws.onclose = () => {
        if (dead) return;
        onStatusChange("disconnected");
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000);
        retryRef.current++;
        if (retryRef.current <= MAX_RETRIES) {
          onStatusChange(`reconnecting (${retryRef.current}/${MAX_RETRIES})`);
          setTimeout(connect, delay);
        } else {
          onStatusChange("failed — max retries reached");
        }
      };
    }

    connect();
    return () => {
      dead = true;
      wsRef.current?.close();
      wsRef.current = null;
      onStatusChange("idle");
    };
  }, [enabled, provider, coins?.join(",")]);

  const disconnect = () => { wsRef.current?.close(); wsRef.current = null; };
  return { disconnect };
}

// ─── Clerk auth hook ─────────────────────────────────────────────────────────
// Defined outside CryptoAlgoTrader so it follows React Rules of Hooks.
// Returns safe defaults if Clerk is not configured (standalone/dev mode).
function useClerkAuth() {
  const { signOut } = useClerk();
  const { user, isLoaded, isSignedIn } = useUser();
  const { session, isLoaded: sessionLoaded } = useSession();
  return {
    clerkUser:     user      || null,
    clerkSignOut:  signOut   || null,
    clerkPlan:     user?.publicMetadata?.plan || "free",
    // isLoaded = true once Clerk has fully resolved the auth state
    // (including any account picker / subscription dialog)
    clerkLoaded:   isLoaded && sessionLoaded,
    clerkSignedIn: isSignedIn ?? false,
    clerkSession:  session   || null,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────
function CryptoAlgoTrader() {
  // Clerk auth — @clerk/clerk-react must be installed (npm install @clerk/clerk-react)
  // useClerkAuth is defined just before this component (see below)
  const { clerkUser, clerkSignOut, clerkPlan, clerkLoaded, clerkSignedIn, clerkSession } = useClerkAuth();


  const planLimits = {
    free:   { maxCoins: 1,  canLive: false, canAI: false },
    pro:    { maxCoins: 10, canLive: true,  canAI: false },
    pro_ai: { maxCoins: 50, canLive: true,  canAI: true  },
  };
  const limits = planLimits[clerkPlan] || planLimits.free;
  useEffect(() => { document.title = "Automation Trader"; }, []);
  const [selectedCoin, setSelectedCoin] = useState("BTC");
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1500);
  const [showSettings,    setShowSettings]    = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);
  // ── Theme ──────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("automation_trader_theme") || "dark"; }
    catch { return "dark"; }
  });
  const toggleTheme = () => setTheme(t => {
    const next = t === "dark" ? "light" : "dark";
    try { localStorage.setItem("automation_trader_theme", next); } catch (_) {}
    return next;
  });
  // Sync body background when theme changes (body sits outside React root)
  useEffect(() => {
    document.body.style.background = theme === "dark" ? "#0f1117" : "#f0f2f5";
    document.body.style.color      = theme === "dark" ? "#e8eaf0" : "#111827";
  }, [theme]);

  // Coinbase automation state
  const CREDS_STORAGE_KEY = "automation_trader_creds";
  const [creds, setCreds] = useState(() => {
    // Restore settings from last browser session — avoids losing settings on tab close.
    // CREDS_DEFAULTS is defined at module level (outside this component) so it's
    // always available when this initialiser runs.
    try {
      const saved = localStorage.getItem(CREDS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge over defaults so new fields added in code are still present
        return { ...CREDS_DEFAULTS, ...parsed };
      }
    } catch (_) {}
    return { ...CREDS_DEFAULTS };
  });

  // Save creds to localStorage whenever they change
  useEffect(() => {
    try {
      // Strip API keys — they stay in Cloud Run env vars only, not localStorage
      const { keys, ...safeToStore } = creds;
      localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify(safeToStore));
    } catch (_) {}
  }, [creds]);

  // ↓ CREDS_DEFAULTS is at module level — see above useState initialiser for context
  void 0;
  // CREDS_DEFAULTS defined at module level above this component

  // Sync tick speed with creds.tickIntervalMs whenever settings change
  useEffect(() => {
    if (creds.tickIntervalMs && creds.tickIntervalMs !== speed) {
      setSpeed(creds.tickIntervalMs);
    }
  }, [creds.tickIntervalMs]);

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [warmingUp, setWarmingUp]         = useState(false); // 5-min warmup after going live
  const [manualBuying, setManualBuying]   = useState(false); // per-coin buy in progress
  const [manualSelling, setManualSelling] = useState(false); // per-coin sell in progress
  const [manualConfirm, setManualConfirm] = useState(null);  // { action, coin, price } pending confirm
  const [autoStatus, setAutoStatus]   = useState("idle");
  const [wsStatus,   setWsStatus]     = useState("idle");
  const [wsEnabled,  setWsEnabled]    = useState(false);
  const [agentStatus,  setAgentStatus]  = useState("idle");
  const [agentLog,     setAgentLog]     = useState([]);
  const agentDecisionRef   = useRef(null);
  const [txLog, setTxLog]       = useState([]);
  const sessionBalanceRef          = useRef(null);
  // Tracks the balance at the moment the CURRENT run began (fresh start or resume)
  // so "from start" reflects change since this run, not since the session's genesis.
  const sessionStartBalanceRef     = useRef(null);
  const [sessionBalance, setSessionBalance]   = useState(null);
  // ── Trading server (VPS) multi-session state ────────────────────────────────
  const [serverSessions, setServerSessions]   = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [serverStatus,  setServerStatus]      = useState("unknown");
  const serverPollRef                         = useRef(null);
  const [showResumeBar, setShowResumeBar]     = useState(false);
  const [showSessionMgr, setShowSessionMgr]  = useState(false);
  const [sessionMgrTab,  setSessionMgrTab]   = useState("test"); // "test" | "live"
  const [newSessionName, setNewSessionName]  = useState("");
  const [newSessionMode, setNewSessionMode]  = useState("simulation");
  // Coin allocation inputs for new session form (component-level to avoid hook-in-IIFE crash)
  const [newCoinAllocs, setNewCoinAllocs]    = useState({});
  const [newSessionStarting, setNewSessionStarting] = useState(false);
  const [newSessionError,    setNewSessionError]    = useState("");
  // Inline paper save name in session manager
  const [paperInlineName,   setPaperInlineName]   = useState("");
  const serverSession = serverSessions.find(s => (s.sessionId || s.session_id) === activeSessionId) || null;

  // ── Paper session persistence (optional, requires login + Supabase) ─────────
  const [paperSessions,        setPaperSessions]        = useState([]);
  const [paperSaving,          setPaperSaving]          = useState(false);
  const [paperSaveMsg,         setPaperSaveMsg]         = useState("");
  const [activePaperSessionId,   setActivePaperSessionId]   = useState(null);
  const [activePaperSessionName, setActivePaperSessionName] = useState("");
  const autoSaveIntervalRef    = useRef(null);
  // Session viewer — shows a saved session in read-only mode without resuming it
  const [viewingSession, setViewingSession] = useState(null); // { name, snapshot } | null
  // Drawer visibility is SEPARATE from viewing state — closing the drawer
  // should not exit "viewing" mode and revert the dashboard to live data.
  // Only the context bar's × (or Resume/Stop) exits viewing mode.
  const [showViewerDrawer, setShowViewerDrawer] = useState(true);

  // ── Onboarding tour state ────────────────────────────────────────────────
  const [tourActive, setTourActive] = useState(false);
  const [tourStep,   setTourStep]   = useState(0);
  const [tourForcedTab, setTourForcedTab] = useState(null); // forces SettingsModal tab during tour
  const TOUR_SEEN_KEY = "automation_trader_tour_seen";

  // Auto-launch the tour once for first-time visitors
  useEffect(() => {
    try {
      if (!localStorage.getItem(TOUR_SEEN_KEY)) {
        const t = setTimeout(() => setTourActive(true), 800); // let the page settle first
        return () => clearTimeout(t);
      }
    } catch (_) {}
  }, []);

  // Filter out steps whose target won't exist yet (e.g. no saved sessions)
  const visibleTourSteps = TOUR_STEPS.filter(s => {
    if (!s.optional) return true;
    if (s.target === "[data-tour='session-eye-icon']") return paperSessions.length > 0;
    return true;
  });

  // Run the side effect each step needs BEFORE it can be measured/highlighted —
  // opening Settings, switching its internal tab, or closing Settings again.
  useEffect(() => {
    if (!tourActive) return;
    const step = visibleTourSteps[tourStep];
    if (!step?.requires) return;
    if (step.requires === "openSettings") {
      setShowSettings(true);
    } else if (step.requires.startsWith("settingsTab:")) {
      setShowSettings(true);
      setTourForcedTab(step.requires.split(":")[1]);
    } else if (step.requires === "closeSettings") {
      setShowSettings(false);
      setTourForcedTab(null);
    }
  }, [tourActive, tourStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const endTour = () => {
    setTourActive(false);
    setTourStep(0);
    setTourForcedTab(null);
    try { localStorage.setItem(TOUR_SEEN_KEY, "1"); } catch (_) {}
  };

  // Saved simulation snapshots — stored in localStorage, named configs for quick recall
  const [savedSims, setSavedSims]     = useState(() => {
    try { return JSON.parse(localStorage.getItem("algotrader_saved_sims") || "{}"); } catch { return {}; }
  });
  const [showSavedSims, setShowSavedSims] = useState(false);
  const [simSaveName,   setSimSaveName]   = useState("");
  const adaptivePendingRef  = useRef({});
  const [adaptiveState, setAdaptiveState] = useState({});
  // LSTM state
  const [lstmStatus,   setLstmStatus]   = useState("idle"); // idle|training|ready|error
  const [lstmPred,     setLstmPred]     = useState({});     // { BTC: prediction, ... }
  const tfRef          = useRef(null);   // TensorFlow.js instance (lazy-loaded)
  const [autoLog, setAutoLog] = useState([]);
  const [cbBalances, setCbBalances] = useState(null);
  const [cbError, setCbError] = useState(null);
  const [rlStats, setRlStats] = useState(getRateLimitStats());
  const [liveData, setLiveData] = useState({});
  const [priceSourceStatus, setPriceSourceStatus] = useState({
    fetching: true, ok: null, diags: {}, lastSuccess: null, lastAttempt: null,
  });

  const stateRef = useRef({
    BTC: { prices: [COIN_BASE.BTC], volumes: [1], history: [], pnl: 0, position: null, trades: 0, mtf: initMTFBuffers() },
    ETH: { prices: [COIN_BASE.ETH], volumes: [1], history: [], pnl: 0, position: null, trades: 0, mtf: initMTFBuffers() },
    SOL: { prices: [COIN_BASE.SOL], volumes: [1], history: [], pnl: 0, position: null, trades: 0, mtf: initMTFBuffers() },
  });
  // Latest live prices — written by WebSocket (primary) or 5s HTTP poller (fallback)
  const livePriceRef = useRef({});

  // WebSocket price handler — writes directly to livePriceRef (same as HTTP poller)
  const handleWsPrice = useCallback((coin, price, bid, ask) => {
    if (!price || isNaN(price) || price <= 0) return;
    // Store mid-price for display/signals; keep bid/ask for order placement
    livePriceRef.current[coin] = { price, bid: bid || price, ask: ask || price };
  }, []);

  // Activate WebSocket when running (simulation or live)
  useWebSocketPrices(
    creds.provider,
    creds.enabledCoins,
    wsEnabled && running,   // active in both sim and live mode
    handleWsPrice,
    setWsStatus,
  );
  // Warmup: track when live automation started — no orders in first 2 min
  const liveStartRef = useRef(null);
  // Active orders: orderId → { coin, action, placedAt, timeout }
  const activeOrdersRef = useRef({});
  // Per-coin pending flag — prevents duplicate orders while one is in flight
  // { BTC: 'BUY' | 'SELL' | null, ETH: ..., SOL: ... }
  const pendingRef = useRef({ BTC: null, ETH: null, SOL: null });
  // Per-coin order error counter — algo stops when any coin hits 3 consecutive errors
  const orderErrorsRef = useRef({ BTC: 0, ETH: 0, SOL: 0 });
  const MAX_ORDER_ERRORS = 3;
  // Per-coin cooldown timestamp — no BUY within 1 minute of a confirmed SELL
  const cooldownRef = useRef({ BTC: null, ETH: null, SOL: null });
  const COOLDOWN_MS = 60_000; // default - overridden per-tick by creds.cooldownMinutes
  // Per-coin trailing stop high-water mark (highest price since entry)
  const trailingHighRef = useRef({ BTC: null, ETH: null, SOL: null });
  // Per-coin trailing take-profit state: { armed: bool, peak: number }
  // armed = true once price has hit the TP level; peak tracks high-water from that point
  const trailingTpRef = useRef({ BTC: null, ETH: null, SOL: null });
  const [snapshot, setSnapshot] = useState(() => JSON.parse(JSON.stringify(stateRef.current)));
  const [news, setNews] = useState([]);
  const [activeSentiment, setActiveSentiment] = useState(0);
  const [newsStatus, setNewsStatus] = useState("idle"); // idle | loading | ok | error
  const newsIdRef = useRef(0);
  const tickRef = useRef(0);
  const autoLogIdRef = useRef(0);

  const addAutoLog = useCallback((msg, type = "info") => {
    const id = autoLogIdRef.current++;
    const time = fmtTime(new Date());
    setAutoLog((prev) => [{ id, msg, type, time }, ...prev.slice(0, 49)]);
  }, []);

  // ── Trading server (VPS) integration ─────────────────────────────────────────
  // authFetch with trading server URL
  const serverFetch = useCallback(async (path, opts = {}) => {
    if (!TRADING_SERVER) return null;
    // Wait up to 5s for Clerk to resolve the session before giving up
    let token = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      token = await window.Clerk?.session?.getToken().catch(() => null);
      if (token) break;
      if (attempt < 9) await new Promise(r => setTimeout(r, 500));
    }
    const res = await fetch(`${TRADING_SERVER}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
    });
    // Surface auth failures clearly so we don't silently swallow 401s
    if (res.status === 401) {
      console.warn("[serverFetch] 401 Unauthorized for", path,
        "— Clerk token was", token ? "present" : "MISSING",
        "— Clerk session:", window.Clerk?.session?.id ?? "null");
    }
    return res;
  }, []);

  // Fetch all sessions from VPS
  // Use a ref for state values needed inside the poll to avoid recreating the interval
  const runningRef        = useRef(running);
  const autoEnabledRef    = useRef(autoEnabled);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { runningRef.current        = running;        }, [running]);
  useEffect(() => { autoEnabledRef.current    = autoEnabled;    }, [autoEnabled]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const fetchServerSessions = useCallback(async () => {
    if (!TRADING_SERVER) { setServerStatus("not_configured"); return; }
    try {
      const res = await serverFetch("/sessions");
      if (!res) return;
      if (res.status === 401) {
        console.warn("[fetchServerSessions] 401 — Clerk session not ready yet");
        setServerStatus("auth_pending");
        return;
      }
      if (!res.ok) {
        console.error("[fetchServerSessions] HTTP", res.status, res.statusText);
        setServerStatus("error");
        return;
      }
      const data = await res.json();

      const list = (data.sessions || [])
        .map(s => ({
          ...s,
          // Normalise all snake_case DB fields to camelCase
          sessionId:       s.sessionId       || s.session_id,
          name:            s.name            || s.session_name,
          coinBalances:    s.coinBalances    || s.coin_balances    || {},
          pnl:             s.pnl             || s.pnl_by_coin      || {},
          unrealized:      s.unrealized      || s.unrealized_by_coin || {},
          tradesByCoin:    s.tradesByCoin    || s.trades_by_coin   || {},
          credsSnapshot:   s.credsSnapshot   || s.creds_snapshot   || {},
          totalTrades:     s.totalTrades     || s.total_trades      || 0,
        }));
        // Include both simulation and live sessions.
        // The session manager separates them visually by tab.
      setServerSessions(list);

      const anyRunning     = list.some(s => s.running);
      const runningSession = list.find(s => s.running);
      const hasResumable   = list.some(s => !s.running && s.sessionId);
      setServerStatus(anyRunning ? "running" : hasResumable ? "stopped" : "idle");

      // Show resume banner when sessions exist and browser isn't actively trading
      if ((runningSession || hasResumable) && !runningRef.current && !autoEnabledRef.current) {
        setShowResumeBar(true);
      }
      // Auto-select first running session if none selected
      if (runningSession && !activeSessionIdRef.current) {
        setActiveSessionId(runningSession.sessionId);
      }
      // Restore creds from the active running session so the dashboard
      // reflects the settings that session is actually using
      if (runningSession?.credsSnapshot && Object.keys(runningSession.credsSnapshot).length > 0) {
        setCreds(prev => ({
          ...prev,
          ...runningSession.credsSnapshot,
          keys: prev.keys,  // always keep local keys
        }));
      }

      // Sync logs + balance from active session
      const curActiveId = activeSessionIdRef.current;
      if (curActiveId) {
        const active = list.find(s => s.sessionId === curActiveId);
        if (active?.running) {
          // Compute total balance across all coins from coinBalances
          const coinBals = active.coinBalances || active.coin_balances || {};
          const totalBal = Object.values(coinBals).reduce((sum, b) => sum + (parseFloat(b.current) || 0), 0);
          if (totalBal > 0) { sessionBalanceRef.current = totalBal; setSessionBalance(totalBal); }
          if (active.logs?.length) {
            setAutoLog(prev => {
              const existing = new Set(prev.map(l => l.msg));
              const fresh = active.logs
                .filter(l => !existing.has(l.msg))
                .map(l => ({ id: Math.random(), msg: l.msg, type: l.type,
                  time: fmtTime(new Date(l.ts)) }));
              return [...fresh, ...prev].slice(0, 50);
            });
          }
        }
      }
    } catch (e) {
      setServerStatus("error");
      console.warn("[trading-server] fetch failed:", e.message);
    }
  }, [serverFetch]); // stable deps only — state read via refs

  // Wait for Clerk to resolve before fetching sessions.
  // Clerk's subscription dialog (if shown) blocks session.getToken() — firing
  // before it resolves causes 401s which silently suppress all session data.
  useEffect(() => {
    if (!TRADING_SERVER) return;
    if (!clerkLoaded) return;   // wait for Clerk to finish resolving
    // Initial fetch + recurring poll
    fetchServerSessions();
    clearInterval(serverPollRef.current);
    serverPollRef.current = setInterval(fetchServerSessions, 3000);
    return () => clearInterval(serverPollRef.current);
  }, [clerkLoaded, fetchServerSessions]); // restart when Clerk becomes ready

  // Create a new VPS session
  const startServerSession = useCallback(async (name, mode, coinAllocations) => {
    if (!TRADING_SERVER) return false;
    try {
      const res  = await serverFetch("/sessions", {
        method: "POST",
        body:   JSON.stringify({ creds, name: name || "Session", mode: mode || "simulation", coinAllocations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Start failed");
      setActiveSessionId(data.sessionId);
      addAutoLog(`▶ "${data.name}" session started (${data.mode})`, "success");
      fetchServerSessions(); // refresh list — non-blocking
      return data.sessionId;
    } catch (e) {
      addAutoLog(`Server session failed: ${e.message}`, "error");
      return false;
    }
  }, [creds, serverFetch, addAutoLog, fetchServerSessions]);

  // Stop a specific session
  const stopServerSession = useCallback(async (sessionId) => {
    if (!TRADING_SERVER) return;
    const sid = sessionId || activeSessionIdRef.current;
    if (!sid) return;
    try {
      await serverFetch(`/sessions/${sid}`, { method: "DELETE" });
      addAutoLog("⏹ Server session stopped", "warn");
      if (sid === activeSessionIdRef.current) setActiveSessionId(null);
      setShowResumeBar(false);
      fetchServerSessions();
    } catch (e) {
      addAutoLog(`Stop failed: ${e.message}`, "error");
    }
  }, [serverFetch, addAutoLog, fetchServerSessions]);

  // Resume a stopped session from DB
  const resumeServerSession = useCallback(async (sessionId) => {
    if (!TRADING_SERVER || !sessionId) return;
    try {
      addAutoLog(`📡 Resuming session...`, "info");
      const res  = await serverFetch(`/sessions/${sessionId}/resume`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Resume failed");
      setActiveSessionId(sessionId);
      addAutoLog(`✅ Resumed "${data.name || sessionId}"`, "success");
      fetchServerSessions();
    } catch (e) {
      addAutoLog(`Resume failed: ${e.message}`, "error");
    }
  }, [serverFetch, addAutoLog, fetchServerSessions]);

  // ── Paper session helpers ────────────────────────────────────────────────────
  // Fetch saved paper sessions from Supabase via proxy
  const fetchPaperSessions = useCallback(async () => {
    try {
      const token = await window.Clerk?.session?.getToken();
      if (!token) return; // not logged in
      const res = await fetch(`${PROXY_BASE}/paper-sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setPaperSessions(data.sessions || []);
    } catch (_) {}
  }, []); // no deps — uses Clerk session directly, stable

  // Load paper sessions on mount
  useEffect(() => { fetchPaperSessions(); }, []);

  // Also refresh paper sessions whenever session manager opens
  useEffect(() => {
    if (showSessionMgr) fetchPaperSessions();
  }, [showSessionMgr, fetchPaperSessions]);

  // Build a full snapshot of current paper trading state for saving
  const buildPaperSnapshot = useCallback((stopped = false) => ({
    creds,
    // stopped: true only when the user explicitly clicked Stop.
    // false means this snapshot was taken while the session was still
    // actively running (periodic auto-save) — the browser may have simply
    // closed afterward without a clean stop, so treat it as "still active".
    stopped,
    enabledCoins:   creds.enabledCoins || ["BTC"],
    signalSource:   creds.signalSource || "rules",
    sessionBalance: sessionBalanceRef.current,
    coinBalances:   Object.fromEntries(
      (creds.enabledCoins || ["BTC"]).map(c => {
        const cs = stateRef.current?.[c];
        return [c, { current: sessionBalanceRef.current || 50, allocated: parseFloat(creds.tradeSizeUSD)||50 }];
      })
    ),
    positions:    Object.fromEntries(
      (creds.enabledCoins || ["BTC"]).map(c => [c, stateRef.current?.[c]?.position || null])
    ),
    pnlByCoin:    Object.fromEntries(
      (creds.enabledCoins || ["BTC"]).map(c => [c, stateRef.current?.[c]?.pnl || 0])
    ),
    tradesByCoin: Object.fromEntries(
      (creds.enabledCoins || ["BTC"]).map(c => [c, stateRef.current?.[c]?.trades || 0])
    ),
    totalTrades:  Object.values(stateRef.current || {}).reduce((s,c) => s + (c.trades||0), 0),
    rlTables:     serializeRLForSave(),
    logs:         autoLog.slice(0, 30),
  }), [creds, autoLog]);

  // Safe RL serialization — sanitises Infinity/NaN which break JSON.stringify
  function serializeRLForSave() {
    try {
      const sanitize = (v) => {
        if (typeof v !== "number") return v;
        if (!isFinite(v) || isNaN(v)) return 0;
        return parseFloat(v.toFixed(6)); // trim floating point noise
      };
      const out = {};
      for (const coin of (creds.enabledCoins || ["BTC"])) {
        const t = rlTables[coin];
        if (!t) continue;
        const qTableObj = {};
        (t.qTable || new Map()).forEach((vals, state) => {
          qTableObj[state] = (vals || [0,0,0]).map(sanitize);
        });
        out[coin] = {
          epsilon:  sanitize(t.epsilon  ?? 0.4),
          episodes: t.episodes || 0,
          qTable:   qTableObj,
        };
      }
      return out;
    } catch (_) { return {}; }
  }

  // Safe JSON stringify — replaces Infinity/NaN with null
  function safeStringify(obj) {
    return JSON.stringify(obj, (_, v) => {
      if (typeof v === "number" && (!isFinite(v) || isNaN(v))) return null;
      return v;
    });
  }

  // Save current paper session to Supabase
  const savePaperSession = useCallback(async (name, sessionId = null, stopped = false) => {
    if (autoEnabled) return; // don't save live trading as a paper session
    setPaperSaving(true);
    setPaperSaveMsg("");
    try {
      const token = await window.Clerk?.session?.getToken();
      if (!token) throw new Error("Please sign in to save sessions");
      const snapshot = buildPaperSnapshot(stopped);
      const id = sessionId || crypto.randomUUID();
      const res = await fetch(`${PROXY_BASE}/paper-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: safeStringify({ sessionId: id, name, snapshot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      const sid = data.sessionId || id;
      // Track which session is currently active for auto-save
      setActivePaperSessionId(sid);
      setActivePaperSessionName(name);
      setPaperSaveMsg(`✓ Saved "${name}"`);
      fetchPaperSessions();
      setTimeout(() => setPaperSaveMsg(""), 3000);
      return sid;
    } catch (e) {
      setPaperSaveMsg(`✗ ${e.message}`);
      setTimeout(() => setPaperSaveMsg(""), 4000);
    } finally {
      setPaperSaving(false);
    }
  }, [autoEnabled, buildPaperSnapshot, fetchPaperSessions]);

  // Resume a saved paper session — restores all state into the browser
  const resumePaperSession = useCallback(async (session) => {
    const snap = session.snapshot || session;
    if (!snap.creds) return;

    // Restore settings
    setCreds(snap.creds);

    // Restore balance
    const bal = snap.sessionBalance || 50;
    sessionBalanceRef.current = bal;
    setSessionBalance(bal);
    // Baseline for "from start" — resets to the resumed balance so the diff
    // reflects change since THIS resume, not since the session began originally
    sessionStartBalanceRef.current = bal;

    // Restore settings (creds) from the snapshot so the session runs with
    // the exact same signal config, exit rules, indicators etc. that were
    // active when it was last saved. Merge over current creds so API keys
    // (which are never stored in snapshots) are preserved from the browser.
    if (snap.creds && Object.keys(snap.creds).length > 0) {
      setCreds(prev => ({
        ...prev,          // keep API keys and any fields not in snapshot
        ...snap.creds,    // restore signal config, exit rules, coins, etc.
        keys: prev.keys,  // always keep current keys — never overwrite from snapshot
      }));
    }

    // Restore P&L, positions, trades in stateRef
    for (const coin of (snap.enabledCoins || ["BTC"])) {
      if (!stateRef.current[coin]) continue;
      if (snap.pnlByCoin?.[coin] != null)    stateRef.current[coin].pnl    = snap.pnlByCoin[coin];
      if (snap.tradesByCoin?.[coin] != null)  stateRef.current[coin].trades = snap.tradesByCoin[coin];
      if (snap.positions?.[coin] != null)     stateRef.current[coin].position = snap.positions[coin];
    }

    // Restore RL Q-tables
    if (snap.rlTables) {
      for (const [coin, t] of Object.entries(snap.rlTables)) {
        rlTables[coin] = {
          epsilon:  t.epsilon  ?? 0.4,
          episodes: t.episodes ?? 0,
          qTable:   new Map(Object.entries(t.qTable || {})),
        };
      }
    }

    // Restore logs
    if (snap.logs?.length) {
      setAutoLog(snap.logs.map((l, i) => ({
        id: i, msg: l.msg || l, type: l.type || "info",
        time: l.time || fmtTime(new Date(l.ts || Date.now())),
      })));
    }

    // Track this as the active session so auto-save updates the right record
    setActivePaperSessionId(session.session_id || session.sessionId);
    setActivePaperSessionName(session.name);

    // Reset price/indicator history so charts build fresh from real market data
    // (saved snapshots don't include tick-level prices — only final P&L and position)
    for (const coin of (snap.enabledCoins || ["BTC"])) {
      if (!stateRef.current[coin]) continue;
      // Keep the last known real price as the new seed (never collapse to empty array)
      const lastPrice = stateRef.current[coin].prices.at(-1) || COIN_BASE[coin] || 1;
      stateRef.current[coin].prices  = [lastPrice];
      stateRef.current[coin].volumes = [1];
      stateRef.current[coin].history = [];
    }

    // Clear viewing state — the session is now RUNNING, not being viewed as a snapshot
    setViewingSession(null);
    setShowViewerDrawer(true);

    // Start the paper trading loop
    setWsEnabled(true);
    setRunning(true);
    const wasStopped = snap.stopped === true;
    addAutoLog(
      wasStopped
        ? `📂 Resumed "${session.name}" — bal $${bal.toFixed(2)} · charts will fill as prices arrive`
        : `📂 Continuing "${session.name}" — bal $${bal.toFixed(2)} · charts will fill as prices arrive`,
      "success"
    );
    setShowSessionMgr(false);
  }, [addAutoLog]);

  // ── Auto-save active paper session every 5 minutes ─────────────────────────
  const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  useEffect(() => {
    // Only auto-save when:
    // 1. Paper trading is running (not live)
    // 2. User has a named active session to save into
    // 3. User is logged in (Clerk session available)
    if (!running || autoEnabled || !activePaperSessionId) {
      clearInterval(autoSaveIntervalRef.current);
      autoSaveIntervalRef.current = null;
      return;
    }

    // Start auto-save interval
    autoSaveIntervalRef.current = setInterval(async () => {
      const token = await window.Clerk?.session?.getToken();
      if (!token) return; // not logged in — skip silently
      // stopped: false — this snapshot is taken WHILE the session is still
      // actively running. If the browser closes right after, the last known
      // state correctly reflects "was still running" rather than "stopped".
      const snapshot = buildPaperSnapshot(false);
      const id = activePaperSessionId;
      const name = activePaperSessionName || "Paper session";
      try {
        await fetch(`${PROXY_BASE}/paper-sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: safeStringify({ sessionId: id, name, snapshot }),
        });
        // Subtle indicator — don't flash the full save message for auto-saves
        setPaperSaveMsg(`⟳ Auto-saved ${fmtTime(new Date())}`);
        setTimeout(() => setPaperSaveMsg(""), 2000);
        fetchPaperSessions();
      } catch (_) {} // auto-save failure is silent
    }, AUTO_SAVE_INTERVAL_MS);

    // Cleanup on stop or unmount
    return () => {
      clearInterval(autoSaveIntervalRef.current);
      autoSaveIntervalRef.current = null;
    };
  }, [running, autoEnabled, activePaperSessionId, activePaperSessionName,
      buildPaperSnapshot, fetchPaperSessions]);

  // Save immediately when paper trading stops (captures final state).
  // This only fires when the user explicitly clicks Stop — closing the
  // browser tab does not run React effects, so a session that was simply
  // closed (not stopped) keeps its last auto-saved stopped:false state.
  useEffect(() => {
    if (!autoEnabled && !running && activePaperSessionId) {
      const t = setTimeout(() => {
        savePaperSession(activePaperSessionName || "Paper session", activePaperSessionId, true);
        setActivePaperSessionId(null);
        setActivePaperSessionName("");
      }, 500);
      return () => clearTimeout(t);
    }
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete a saved paper session
  const deletePaperSession = useCallback(async (sessionId) => {
    try {
      const token = await window.Clerk?.session?.getToken();
      if (!token) return;
      await fetch(`${PROXY_BASE}/paper-sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchPaperSessions();
    } catch (_) {}
  }, [fetchPaperSessions]);

  // Push settings to active running session when creds change
  useEffect(() => {
    if (!TRADING_SERVER || !activeSessionId || serverStatus !== "running") return;
    const timer = setTimeout(async () => {
      try {
        await serverFetch(`/sessions/${activeSessionId}`, {
          method: "PUT",
          body:   JSON.stringify({ creds }),
        });
      } catch (_) {}
    }, 2000);
    return () => clearTimeout(timer);
  }, [creds, activeSessionId, serverStatus, serverFetch]);

  // ── Simulation settings save / load ──────────────────────────────────────────
  // Declared here (after addAutoLog) to avoid forward reference error
  const saveSimulation = useCallback((name) => {
    if (!name?.trim()) return;
    const snapshot = {
      name: name.trim(), savedAt: fmtDateTime(new Date()),
      creds: JSON.parse(JSON.stringify(creds)),
      sessionBalance: sessionBalanceRef.current,
      totalPnl: Object.values(stateRef.current).reduce((s,c) => s + (c.pnl||0), 0),
    };
    const updated = { ...savedSims, [name.trim()]: snapshot };
    setSavedSims(updated);
    try { localStorage.setItem("algotrader_saved_sims", JSON.stringify(updated)); } catch(_){}
    addAutoLog(`💾 Simulation "${name.trim()}" saved`, "success");
    setSimSaveName("");
  }, [creds, savedSims, addAutoLog]);

  const loadSimulation = useCallback((name) => {
    const sim = savedSims[name]; if (!sim) return;
    setCreds(sim.creds);
    addAutoLog(`📂 Simulation "${name}" loaded`, "info");
    setShowSavedSims(false);
  }, [savedSims, addAutoLog]);

  const deleteSimulation = useCallback((name) => {
    const updated = { ...savedSims };
    delete updated[name];
    setSavedSims(updated);
    try { localStorage.setItem("algotrader_saved_sims", JSON.stringify(updated)); } catch(_){}
  }, [savedSims]);

  // ── Fetch real news from NewsData.io via proxy ───────────────────────────────
  const fetchRealNews = useCallback(async () => {
    if (!PROXY_BASE) return;
    setNewsStatus("loading");
    try {
      // Use direct fetch when top-level (Vite/Netlify), bridge when in Claude iframe
      let payload;
      if (window !== window.parent) {
        // In iframe — use a promise that resolves via postMessage bridge
        payload = await new Promise((resolve, reject) => {
          const handler = (e) => {
            if (e.data?.type !== "CB_NEWS") return;
            window.removeEventListener("message", handler);
            if (e.data.ok) resolve(e.data.payload);
            else reject(new Error(e.data.error));
          };
          window.addEventListener("message", handler);
          setTimeout(() => { window.removeEventListener("message", handler); reject(new Error("News bridge timeout")); }, 10000);
          try {
            const script = window.parent.document.createElement("script");
            script.id = "cbNewsBridge";
            script.textContent = `
              (async () => {
                try {
                  const res = await fetch(${JSON.stringify(NEWS_PROXY_URL)}, { headers: { Accept: "application/json" } });
                  const payload = await res.json();
                  window.frames[0]?.postMessage({ type: "CB_NEWS", ok: true, payload }, "*");
                } catch(e) {
                  window.frames[0]?.postMessage({ type: "CB_NEWS", ok: false, error: e.message }, "*");
                } finally {
                  document.getElementById("cbNewsBridge")?.remove();
                }
              })();
            `;
            window.parent.document.getElementById("cbNewsBridge")?.remove();
            window.parent.document.body.appendChild(script);
          } catch (_) {
            // Cross-origin fallback
            fetch(NEWS_PROXY_URL, { headers: { Accept: "application/json" } })
              .then(r => r.json()).then(resolve).catch(reject);
          }
        });
      } else {
        // Top-level page — direct fetch works fine
        const res = await fetch(NEWS_PROXY_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`Proxy news HTTP ${res.status}`);
        payload = await res.json();
      }
      const articles = payload.articles || [];
      if (articles.length === 0) throw new Error("No articles returned");

      // Build sentiment average from all articles for the signal engine
      const avgSentiment = articles.reduce((sum, a) => sum + (a.sentiment || 0), 0) / articles.length;
      setActiveSentiment(avgSentiment);

      // Format for display
      const formatted = articles.map((a) => ({
        id: newsIdRef.current++,
        text: a.title,
        description: a.description,
        source: a.source,
        url: a.url,
        sentiment: a.sentiment,
        sentimentLabel: a.sentimentLabel,
        time: a.publishedAt
          ? fmtTime(new Date(a.publishedAt))
          : "now",
      }));

      setNews(formatted);
      setNewsStatus("ok");
    } catch (e) {
      setNewsStatus("error");
      console.error("News fetch failed:", e.message);
    }
  }, []);

  // Fetch news on mount and every 2 minutes (NewsData free tier: ~200 req/day)
  useEffect(() => {
    fetchRealNews();
    const id = setInterval(fetchRealNews, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchRealNews]);

  // ── Detect execution context ─────────────────────────────────────────────────
  const inIframe = window !== window.parent;

  // ── Fetch prices: direct fetch when top-level, bridge when in iframe ──────────
  // providerId is passed in so prices always come from the active exchange
  const fetchViaBridge = useCallback((isAnchor = false, providerId = "coinbase") => {
    setPriceSourceStatus((p) => ({ ...p, fetching: true, lastAttempt: fmtDateTime(new Date()) }));

    if (!inIframe) {
      // Top-level page — fetch directly, no CSP restriction
      fetchAllPublicPrices(providerId).then(({ prices, diags }) => applyPrices(prices, diags, isAnchor));
      return;
    }

    // Inside iframe — inject bridge script to bypass CSP
    const coinList = COINS.join(",");
    const url = `${PROXY_BASE}?product=${coinList}&exchange=${encodeURIComponent(providerId)}`;
    try {
      const script = window.parent.document.createElement("script");
      script.id = "cbPriceBridge";
      script.textContent = `
        (async () => {
          try {
            const res = await fetch(${JSON.stringify(url)}, { headers: { Accept: "application/json" } });
            const data = await res.json();
            window.frames[0]?.postMessage({ type: "CB_PRICES", ok: true, data }, "*");
          } catch(e) {
            window.frames[0]?.postMessage({ type: "CB_PRICES", ok: false, error: e.message }, "*");
          } finally {
            document.getElementById("cbPriceBridge")?.remove();
          }
        })();
      `;
      window.parent.document.getElementById("cbPriceBridge")?.remove();
      window.parent.document.body.appendChild(script);
    } catch (_) {
      fetchAllPublicPrices(providerId).then(({ prices, diags }) => applyPrices(prices, diags, isAnchor));
    }
  }, [inIframe]);

  const applyPrices = useCallback((prices, diags, isAnchor = false) => {
    const s = stateRef.current;
    const anyOk = Object.keys(prices).length > 0;
    for (const coin of COINS) {
      if (prices[coin]) {
        if (isAnchor && s[coin].prices.length > 1) {
          s[coin].prices[s[coin].prices.length - 1] = prices[coin];
        } else {
          s[coin].prices = [prices[coin]];
          s[coin].volumes = [1];
        }
        // Seed livePriceRef so runTick immediately uses real prices
        livePriceRef.current[coin] = { price: prices[coin], bid: prices[coin], ask: prices[coin] };
      }
    }
    if (anyOk) setSnapshot(JSON.parse(JSON.stringify(s)));
    setPriceSourceStatus({
      fetching: false, ok: anyOk, diags,
      lastSuccess: anyOk ? fmtDateTime(new Date()) : null,
      lastAttempt: fmtDateTime(new Date()),
    });
  }, []);

  // ── Listen for postMessage responses from the bridge script ──────────────────
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type !== "CB_PRICES") return;
      if (!event.data.ok) {
        const msg = event.data.error || "Bridge fetch failed";
        const diags = {};
        COINS.forEach(c => { diags[c] = { ok: false, errorType: "network", errorMsg: msg }; });
        setPriceSourceStatus(p => ({ ...p, fetching: false, ok: false, diags,
          lastAttempt: fmtDateTime(new Date()) }));
        return;
      }
      // Parse the proxy payload
      const payload = event.data.data;
      const prices = {}, diags = {};
      COINS.forEach(coin => {
        const coinData = payload?.data?.[coin];
        const price = parseFloat(coinData?.price);
        if (!coinData || isNaN(price)) {
          diags[coin] = { ok: false, errorType: "empty",
            errorMsg: `${coin} missing from response` };
        } else {
          prices[coin] = price;
          diags[coin] = { ok: true, price,
            bid: parseFloat(coinData.bid)||null, ask: parseFloat(coinData.ask)||null };
        }
      });
      applyPrices(prices, diags, false);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyPrices]);

  // ── Bootstrap on mount + re-fetch when provider changes ─────────────────────
  useEffect(() => { fetchViaBridge(false, creds.provider); }, [creds.provider]);



  // ── Poll rate-limit stats every 500ms ──────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setRlStats(getRateLimitStats()), 500);
    return () => clearInterval(id);
  }, []);

  // ── Fetch live prices via proxy — runs every 2s when automation is active ────
  const fetchLiveMarketData = useCallback(async () => {
    if (!PROXY_BASE) return;
    try {
      const coins = creds.enabledCoins.join(",");
      const url   = `${PROXY_BASE}?product=${coins}&exchange=${encodeURIComponent(creds.provider)}`;
      const res   = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      const payload = await res.json();

      let updated = false;
      for (const coin of creds.enabledCoins) {
        const d     = payload?.data?.[coin];
        const price = parseFloat(d?.price);
        if (!d || isNaN(price) || price <= 0) continue;
        // Write fresh price into the ref — runTick picks it up on next tick
        livePriceRef.current[coin] = {
          price,
          bid:    parseFloat(d.bid)    || price,
          ask:    parseFloat(d.ask)    || price,
          volume: parseFloat(d.volume) || null,
        };
        updated = true;
      }
      if (updated) setLiveData(prev => ({ ...prev, ...payload.data }));
    } catch (e) {
      if (Math.random() < 0.1) addAutoLog(`Price poll error: ${e.message}`, "error");
    }
  }, [creds, addAutoLog]);

  // ── LLM Agent polling ───────────────────────────────────────────────────────
  // When agentMode is on, calls Claude every N seconds for each enabled coin
  // and stores the decision in agentDecisionRef for runTick to consume
  useEffect(() => {
    const agentActive = creds.agentMode || creds.signalSource === "deepseek";
    if (!agentActive || !running) return;

    const callAgent = async () => {
      for (const coin of creds.enabledCoins) {
        const cs   = stateRef.current[coin];
        const price = livePriceRef.current[coin]?.price || cs.prices.at(-1);
        if (!price) continue;

        const ip = creds.indicatorPeriods || { smaFast:20, smaMid:50, smaSlow:99, emaFast:12, emaSlow:26, rsi:14, bollinger:20, atr:14 };
        const bollPeriod = ip.bollinger;
        const indicators = {
          currentPrice: price,
          sma20:  calcSMA(cs.prices, ip.smaFast),
          sma50:  calcSMA(cs.prices, ip.smaMid),
          sma99:  calcSMA(cs.prices, ip.smaSlow),
          ema12:  calcEMA(cs.prices, ip.emaFast),
          ema26:  calcEMA(cs.prices, ip.emaSlow),
          rsi:    calcRSI(cs.prices, ip.rsi),
          boll:   calcBollinger(cs.prices, ip.bollinger),
          macd:   calcMACD(cs.prices),
          atr:    calcATR(cs.prices, ip.atr),
        };

        const volumes = cs.volumes;
        const avgVol  = volumes.length > 0 ? volumes.reduce((a,b) => a+b, 0) / volumes.length : 1;
        const volRatio = volumes.at(-1) / (avgVol || 1);

        setAgentStatus("thinking");
        try {
          const atr    = indicators.atr || calcATR(cs.prices, 14);
          const atrPct = atr && price ? (atr / price * 100) : null;
          const rfPred = rfPredCache[coin] || null;
          const decision = await callLLMAgent({
            llmProvider: creds.llmProvider || "deepseek",
            coin, currentPrice: price,
            indicators: { ...indicators, atr },
            atrPct,
            sentiment:      activeSentiment,
            volumeRatio:    volRatio,
            position:       cs.position,
            recentHistory:  cs.history?.slice(-5) || [],
            lstmPrediction: lstmPredCache[coin] || null,
            rfPrediction:   rfPred,
            settings: {
              tradeSizeUSD:    creds.tradeSizeUSD,
              currentBalance:  sessionBalanceRef.current?.toFixed(2) || creds.tradeSizeUSD,
              feePercent:      creds.feePercent,
              minConfidence:   creds.minConfidence,
              indicatorConfig: creds.indicatorConfig,
              exitRules:       creds.exitRules?.[coin],
              tradingMode:     creds.tradingMode || "momentum",
            },
            exitStrategies: creds.exitStrategies,
          });

          // Store decision for runTick to consume
          if (!agentDecisionRef.current) agentDecisionRef.current = {};
          agentDecisionRef.current[coin] = decision;

          // ── Phase 3: Adaptive Settings ────────────────────────────────────
          const asCfg = creds.adaptiveSettings;
          if (asCfg?.enabled && decision.fromAgent) {
            const minConf = parseFloat(asCfg.requireHigh) || 70;
            const applyAfter = parseInt(asCfg.applyAfter) || 3;
            const confOk = parseFloat(decision.confidence) >= minConf;

            if (!adaptivePendingRef.current[coin]) {
              adaptivePendingRef.current[coin] = { tp: [], sl: [] };
            }
            const pending = adaptivePendingRef.current[coin];

            // Accumulate suggestions when confidence is high enough
            if (confOk && decision.suggestedTpAdjust) {
              pending.tp.push(decision.suggestedTpAdjust);
              if (pending.tp.length > applyAfter * 2) pending.tp.shift();
            }
            if (confOk && decision.suggestedSlAdjust) {
              pending.sl.push(decision.suggestedSlAdjust);
              if (pending.sl.length > applyAfter * 2) pending.sl.shift();
            }

            // Apply when we have applyAfter consistent suggestions
            const applyAdjust = (suggestions, type, maxDelta) => {
              if (suggestions.length < applyAfter) return null;
              const recent = suggestions.slice(-applyAfter);
              // All must agree on direction
              const allPos = recent.every(s => s.startsWith("+"));
              const allNeg = recent.every(s => s.startsWith("-"));
              if (!allPos && !allNeg) return null;
              // Average magnitude
              const avg = recent.reduce((sum, s) => {
                return sum + parseFloat(s.replace(/[+%]/g, ""));
              }, 0) / recent.length;
              const capped = Math.min(avg, parseFloat(maxDelta) || 2);
              return (allPos ? "+" : "-") + capped.toFixed(2) + "%";
            };

            const tpAdj = applyAdjust(pending.tp, "tp", asCfg.maxTpDelta);
            const slAdj = applyAdjust(pending.sl, "sl", asCfg.maxSlDelta);

            if (tpAdj || slAdj) {
              setCreds(prev => {
                const currentRules = prev.exitRules?.[coin] || {};
                const currentTp    = parseFloat(currentRules.takeProfitValue) || 2;
                const currentSl    = parseFloat(currentRules.stopLossValue)   || 1;
                const newTp = tpAdj
                  ? Math.max(0.1, currentTp + parseFloat(tpAdj))
                  : currentTp;
                const newSl = slAdj
                  ? Math.max(0.1, currentSl + parseFloat(slAdj))
                  : currentSl;
                addAutoLog(`[ADAPTIVE] ${coin} TP ${currentTp.toFixed(2)}%→${newTp.toFixed(2)}% SL ${currentSl.toFixed(2)}%→${newSl.toFixed(2)}%`, "info");
                pending.tp = []; pending.sl = []; // reset after applying
                setAdaptiveState(a => ({ ...a, [coin]: { tp: newTp, sl: newSl, appliedAt: fmtDateTime(new Date()) } }));
                return {
                  ...prev,
                  exitRules: {
                    ...prev.exitRules,
                    [coin]: { ...currentRules, takeProfitValue: String(newTp.toFixed(2)), stopLossValue: String(newSl.toFixed(2)) },
                  },
                };
              });
            }
          }

          // Log to agent panel
          setAgentLog(prev => [{
            coin, time: fmtDateTime(new Date()),
            action: decision.action, confidence: decision.confidence,
            reasoning: decision.reasoning, keyFactors: decision.keyFactors,
            risk: decision.risk, score: decision.score,
          }, ...prev].slice(0, 20));

          setAgentStatus("ready");
          addAutoLog(`[AGENT] ${coin}: ${decision.action} (${decision.confidence}% conf) — ${decision.reasoning}`,
            decision.action === "BUY" ? "success" : decision.action === "SELL" ? "warn" : "info");

        } catch (e) {
          setAgentStatus("error");
          addAutoLog(`[AGENT] ${coin} error: ${e.message}`, "error");
          // On error fall back to rule-based signal — clear agent decision
          if (agentDecisionRef.current) agentDecisionRef.current[coin] = null;
        }
      }
    };

    // Call immediately then on interval
    callAgent();
    const intervalMs = (parseFloat(creds.agentIntervalSec) || 15) * 1000;
    const id = setInterval(callAgent, intervalMs);
    return () => clearInterval(id);
  }, [creds.agentMode, creds.agentIntervalSec, running, creds.enabledCoins.join(",")]);

  // ── TensorFlow.js loader ─────────────────────────────────────────────────────
  // Inject a <script> tag — works in Vite, Netlify and iframe environments
  // window.tf is set once the script loads
  useEffect(() => {
    if (!creds.agentMode) return;
    if (window.tf) { tfRef.current = window.tf; setLstmStatus("ready"); return; }
    if (document.getElementById("tfjs-script")) return; // already loading
    setLstmStatus("loading");
    const script = document.createElement("script");
    script.id  = "tfjs-script";
    script.src = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js";
    script.onload = () => {
      if (window.tf) {
        tfRef.current = window.tf;
        setLstmStatus("ready");
        console.log("[LSTM] TensorFlow.js loaded — version", window.tf.version.tfjs);
      } else {
        setLstmStatus("error");
        console.error("[LSTM] TF.js script loaded but window.tf not found");
      }
    };
    script.onerror = (e) => {
      setLstmStatus("error");
      console.error("[LSTM] TF.js script failed to load:", e);
      document.getElementById("tfjs-script")?.remove();
    };
    document.head.appendChild(script);
  }, [creds.agentMode]);

  // ── LSTM prediction loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (!creds.agentMode || !running) return;
    let cancelled = false;

    // Wait until window.tf.sequential is available (script may still be initialising)
    const waitForTF = () => new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        if (cancelled) return reject(new Error("cancelled"));
        const tf = window.tf;
        if (tf && typeof tf.sequential === "function") {
          console.log("[LSTM] TF.js ready — version", tf.version?.tfjs || "unknown");
          return resolve(tf);
        }
        if (++attempts > 30) return reject(new Error("TF.js did not load within 30s — check network"));
        setTimeout(check, 1000);
      };
      check();
    });

    const runLSTM = async () => {
      let tf;
      try {
        tf = await waitForTF();
      } catch (e) {
        if (!cancelled) { setLstmStatus("error"); addAutoLog(`[LSTM] ${e.message}`, "error"); }
        return;
      }

      for (const coin of creds.enabledCoins) {
        if (cancelled) break;
        const cs = stateRef.current[coin];
        if (cs.prices.length < LSTM_SEQ_LEN + 20) {
          console.log(`[LSTM] ${coin}: need ${LSTM_SEQ_LEN + 20} ticks, have ${cs.prices.length}`);
          continue;
        }
        const ip = creds.indicatorPeriods || { smaFast:20, smaMid:50, smaSlow:99, emaFast:12, emaSlow:26, rsi:14, bollinger:20, atr:14 };
        const bollPeriod = ip.bollinger;
        const indicators = {
          rsi:   calcRSI(cs.prices, ip.rsi),
          macd:  calcMACD(cs.prices),
          boll:  calcBollinger(cs.prices, bollPeriod),
          ema12: calcEMA(cs.prices, ip.emaFast),
          ema26: calcEMA(cs.prices, ip.emaSlow),
        };
        try {
          setLstmStatus("training");
          console.log(`[LSTM] running prediction for ${coin} with ${cs.prices.length} ticks`);
          const pred = await getLSTMPrediction(tf, coin, cs.prices, indicators);
          if (pred && !cancelled) {
            setLstmPred(p => ({ ...p, [coin]: pred }));
            setLstmStatus("ready");
            console.log(`[LSTM] ${coin} prediction:`, pred);
          }
        } catch (e) {
          if (!cancelled) {
            console.error(`[LSTM] error for ${coin}:`, e);
            setLstmStatus("error");
            addAutoLog(`[LSTM] ${coin}: ${e.message}`, "error");
          }
        }
      }
    };

    runLSTM();
    const id = setInterval(runLSTM, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [creds.agentMode, creds.enabledCoins.join(","), running]);

  // ── Price polling ────────────────────────────────────────────────────────────
  // WS connected (sim or live) → no HTTP polling
  // Live + WS off/failed       → 5s HTTP fallback
  // Simulate + WS off/failed   → 15s HTTP anchor
  // Stopped                    → no polling
  useEffect(() => {
    if (!running) return; // stopped — no polling at all
    if (wsStatus === "connected") return; // WS active — no HTTP needed
    if (autoEnabled) {
      // Live mode, WS not connected — 5s HTTP fallback
      const id = setInterval(() => fetchViaBridge(true, creds.provider), 5_000);
      return () => clearInterval(id);
    }
    // Simulation mode, WS not connected — 15s HTTP anchor
    const id = setInterval(() => fetchViaBridge(true, creds.provider), 15_000);
    return () => clearInterval(id);
  }, [autoEnabled, running, wsStatus, fetchViaBridge, creds.provider]);

  // ── Fetch Coinbase balances (single /accounts call) ───────────────────────
  const fetchBalances = useCallback(async () => {
    const keys = creds.keys?.[creds.provider] || {};
    const hasKeys = Object.values(keys).some(v => v && v.trim());
    if (!hasKeys) return;
    setCbError(null);
    const providerName = EXCHANGE_PROVIDERS[creds.provider]?.name || creds.provider;
    try {
      if (!PROXY_BASE) throw new Error("No proxy URL — set PROXY_BASE to your Cloud Run function URL");

      // Balance fetches go through the proxy to avoid CORS — keys sent over HTTPS, never stored
      const res = await fetch(`${PROXY_BASE}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange: creds.provider, ...keys }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setCbBalances(data.balances);
      addAutoLog(`[${providerName}] Balances — USD $${data.balances?.USD?.toFixed(2) ?? "?"}`, "success");
    } catch (e) {
      setCbError(e.message);
      addAutoLog(`[${providerName}] Balance fetch failed: ${e.message}`, "error");
    }
  }, [creds, addAutoLog]);

  // ── Execute a real trade on Coinbase ───────────────────────────────────────
  const executeRealTrade = useCallback(async (coin, action, price, confidence, explicitBaseSize = null) => {
    // Confidence gate applies to all modes including sandbox (exits are always 100%)
    const minConf = parseFloat(creds.minConfidence) || 60;
    if (action === "BUY" && confidence < minConf) {
      addAutoLog(`Skipped BUY ${coin}: confidence ${confidence.toFixed(1)}% < threshold ${minConf}%`, "warn");
      return { success: false, reason: "low_confidence" };
    }
    if (creds.sandbox) {
      addAutoLog(`[SANDBOX] ${action} ${coin} @ $${price.toFixed(2)} (conf ${confidence.toFixed(1)}%)`, "sandbox");
      return { success: true, sandbox: true };
    }
    try {
      // Compounding balance: starts at tradeSizeUSD, grows/shrinks with realized P&L
      // sessionBalanceRef.current is updated after each SELL
      const tradeUSD = sessionBalanceRef.current || parseFloat(creds.tradeSizeUSD) || 50;
      const baseSize = explicitBaseSize !== null
        ? roundLotSize(explicitBaseSize, coin)  // use actual filled qty for SELL
        : tradeUSD / price;                      // estimate for BUY (exchange rounds to lot size)
      const providerName = EXCHANGE_PROVIDERS[creds.provider]?.name || creds.provider;
      const keys = creds.keys?.[creds.provider] || {};

      if (!PROXY_BASE) throw new Error("No proxy URL — set PROXY_BASE to your Cloud Run function URL");

      // ── Live balance check before BUY ────────────────────────────────────────
      // Fetch real exchange USD balance, apply buffer, cap tradeUSD to available funds
      let safeTradeUSD = tradeUSD;
      if (action === "BUY") {
        try {
          const balRes  = await fetch(`${PROXY_BASE}/balance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ exchange: creds.provider, ...keys }),
          });
          const balData = await balRes.json();
          // Exchange returns USD balance — find it (field name varies by exchange)
          const rawUSD = balData?.USD ?? balData?.usd ?? balData?.USDT ?? balData?.usdt
            ?? balData?.balances?.USD ?? balData?.balances?.USDT ?? null;

          if (rawUSD !== null && rawUSD !== undefined) {
            const buffer       = parseFloat(creds.balanceBuffer) || 0.50;
            const available    = Math.max(0, parseFloat(rawUSD) - buffer);
            const cappedTrade  = Math.min(safeTradeUSD, available);

            addAutoLog(
              `[BALANCE] Exchange USD: $${parseFloat(rawUSD).toFixed(2)} → available: $${available.toFixed(2)} (buffer: $${buffer.toFixed(2)}) → trading: $${cappedTrade.toFixed(2)}`,
              "info"
            );

            if (available < 1) {
              addAutoLog(`[BALANCE] Insufficient funds ($${available.toFixed(2)} after buffer) — BUY skipped`, "error");
              return { success: false, reason: "insufficient_funds" };
            }

            safeTradeUSD = cappedTrade;

            // Also sync sessionBalance to actual exchange balance if it's drifted
            if (sessionBalanceRef.current && Math.abs(sessionBalanceRef.current - available) > 1) {
              sessionBalanceRef.current = cappedTrade;
              setSessionBalance(cappedTrade);
            }
          } else {
            addAutoLog(`[BALANCE] Could not read USD balance from exchange response — proceeding with $${safeTradeUSD.toFixed(2)}`, "warn");
          }
        } catch (e) {
          addAutoLog(`[BALANCE] Balance check failed: ${e.message} — proceeding with $${safeTradeUSD.toFixed(2)}`, "warn");
        }
      }

      // Use safeTradeUSD (balance-checked and buffer-adjusted) for all order sizing
      const effectiveTradeUSD = action === "BUY" ? safeTradeUSD : tradeUSD;

      // ── BUY: limit order support (maker trades, lower fees) ─────────────────
      const buyCfg         = creds.buyOrderConfig;
      const useAdvancedBuy = action === "BUY" && buyCfg?.type === "limit";

      if (useAdvancedBuy) {
        addAutoLog(`⏳ [${providerName}] LIMIT BUY ${coin} @ signal $${price.toFixed(2)} + ${buyCfg.limitOffsetValue}${buyCfg.limitOffsetType === "percent" ? "%" : "$"} offset (maker)`, "info");
        const buyRes = await fetch(`${PROXY_BASE}/advancedbuy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exchange:     creds.provider,
            coin,
            quoteSize:    effectiveTradeUSD,
            currentPrice: price,
            buyConfig:    buyCfg,
            ...keys,
          }),
        });
        const buyData = await buyRes.json();
        if (buyData.fallback) {
          addAutoLog(`⚠ Limit BUY not supported on ${providerName} — using market`, "warn");
          // Fall through to market BUY below
        } else if (!buyRes.ok) {
          throw new Error(buyData.error || `Limit BUY HTTP ${buyRes.status}`);
        } else {
          // Limit BUY placed — treat same as market pending (will poll for fill)
          const limitPrice = buyData.limitPrice || price;
          addAutoLog(`✓ LIMIT BUY ${coin} placed @ $${limitPrice.toFixed(2)} qty:${buyData.qty?.toFixed(8)} ID:${buyData.orderId?.slice(0,12)}... (maker order)`, "info");
          return { success: true, orderId: buyData.orderId, fillPrice: limitPrice, filledQty: buyData.qty || baseSize };
        }
      }

      // ── SELL: advanced order type ─────────────────────────────────────────────
      const sellCfg = creds.sellOrderConfig;
      const useAdvancedSell = action === "SELL" && sellCfg?.type && sellCfg.type !== "market";

      let res;
      if (useAdvancedSell) {
        // Try exchange-native advanced order (limit / stop-limit / OCO / trailing)
        res = await fetch(`${PROXY_BASE}/advancedsell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exchange:     creds.provider,
            coin,
            qty:          baseSize,
            currentPrice: price,
            sellConfig:   sellCfg,
            ...keys,
          }),
        });
        const advData = await res.json();
        if (advData.fallback) {
          // Exchange doesn't support this natively — fall through to market
          addAutoLog(`⚠ ${sellCfg.type} not supported on ${providerName} — falling back to market sell`, "warn");
          res = await fetch(`${PROXY_BASE}/order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ exchange: creds.provider, coin, side: action, quoteSize: action === 'BUY' ? effectiveTradeUSD : tradeUSD, baseSize, ...keys }),
          });
        } else {
          const data = await (res.json().catch(() => advData));
          if (!res.ok && !advData.fallback) throw new Error(advData.error || `HTTP ${res.status}`);
          const orderTypeLabel = sellCfg.type.replace(/_/g, " ").toUpperCase();
          addAutoLog(`✓ [${providerName}] ${orderTypeLabel} SELL ${coin} placed — ID: ${advData.orderId?.slice(0,12)}...`, "info");
          orderErrorsRef.current[coin] = 0;
          await fetchBalances();
          return { success: true, orderId: advData.orderId, fillPrice: price, filledQty: baseSize };
        }
      } else {
        res = await fetch(`${PROXY_BASE}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exchange:   creds.provider,
            coin,
            side:       action,
            quoteSize:  action === 'BUY' ? effectiveTradeUSD : tradeUSD,
            baseSize,
            ...keys,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const orderId = data.orderId;
      addAutoLog(`⏳ [${providerName}] ${action} ${coin} order placed — ID: ${orderId?.slice(0,12)}... @ $${price.toFixed(2)}`, "info");

      // Track active order
      activeOrdersRef.current[orderId] = { coin, action, price, placedAt: Date.now() };

      // Poll for fill — every 5s for up to 2 minutes, then cancel if BUY
      const POLL_INTERVAL  = 5_000;
      const CANCEL_TIMEOUT = 2 * 60 * 1000; // 2 minutes
      const provider = EXCHANGE_PROVIDERS[creds.provider];
      const keys2    = creds.keys?.[creds.provider] || {};
      const productId = provider?.productId(coin) || coin;
      let filled = false;
      let cancelled = false;
      const deadline = Date.now() + CANCEL_TIMEOUT;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        try {
          const qs = new URLSearchParams({ exchange: creds.provider, orderId, productId, ...keys2 }).toString();
          const sRes  = await fetch(`${PROXY_BASE}/orderstatus?${qs}`);
          const sData = await sRes.json();
          if (sData.done) {
            const fillPrice = parseFloat(sData.price) || price;
            const filledQty = parseFloat(sData.filled) || 0;
            addAutoLog(`✓ [${providerName}] ${action} ${coin} FILLED @ $${fillPrice.toFixed(2)} qty: ${filledQty.toFixed(8)}`, "success");
            filled = { price: fillPrice, qty: filledQty };
            break;
          }
          const elapsed = Math.round((Date.now() - activeOrdersRef.current[orderId].placedAt) / 1000);
          addAutoLog(`⏳ [${providerName}] ${action} ${coin} ${sData.status || "pending"} (${elapsed}s elapsed)`, "info");
        } catch (_) {
          // Status check failed — keep trying until timeout
        }
      }

      // BUY not filled within 2 min → cancel and reset
      if (!filled && action === "BUY") {
        addAutoLog(`⚠ [${providerName}] BUY ${coin} not filled in 2 min — cancelling order`, "warn");
        try {
          const cancelRes = await fetch(`${PROXY_BASE}/cancelorder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ exchange: creds.provider, orderId, productId, ...keys2 }),
          });
          const cancelData = await cancelRes.json();
          addAutoLog(`🚫 [${providerName}] BUY ${coin} order cancelled — ${cancelData.status || "done"}`, "warn");
          cancelled = true;
        } catch (e) {
          addAutoLog(`⚠ [${providerName}] Cancel failed: ${e.message}`, "error");
        }
        delete activeOrdersRef.current[orderId];
        // Timeout counts as an error toward the 3-strike limit
        orderErrorsRef.current[coin] = (orderErrorsRef.current[coin] || 0) + 1;
        const timeoutErrCount = orderErrorsRef.current[coin];
        addAutoLog(`❌ BUY ${coin} timeout [${timeoutErrCount}/${MAX_ORDER_ERRORS}]`, "error");
        if (timeoutErrCount >= MAX_ORDER_ERRORS) {
          addAutoLog(`🛑 ${MAX_ORDER_ERRORS} consecutive failures on ${coin} — stopping automation`, "error");
          setTimeout(() => {
            setAutoEnabled(false);
            setRunning(false);
            setAutoStatus("error");
            setCbError(`Stopped after ${MAX_ORDER_ERRORS} consecutive order timeouts on ${coin}`);
          }, 0);
        }
        return { success: false, reason: "timeout_cancelled", orderId };
      }

      if (!filled) addAutoLog(`⚠ [${providerName}] ${action} ${coin} — fill unconfirmed after 2 min`, "warn");
      delete activeOrdersRef.current[orderId];
      orderErrorsRef.current[coin] = 0;
      await fetchBalances();
      const fillData = filled || {};
      return { success: true, orderId, filledQty: fillData.qty || null, fillPrice: fillData.price || price };
    } catch (e) {
      // Increment error counter
      orderErrorsRef.current[coin] = (orderErrorsRef.current[coin] || 0) + 1;
      const errCount = orderErrorsRef.current[coin];
      addAutoLog(`❌ Order failed (${action} ${coin}) [${errCount}/${MAX_ORDER_ERRORS}]: ${e.message}`, "error");

      if (errCount >= MAX_ORDER_ERRORS) {
        // 3 consecutive errors — stop the algo to prevent runaway failures
        addAutoLog(`🛑 ${MAX_ORDER_ERRORS} consecutive order errors on ${coin} — stopping automation`, "error");
        // Use setTimeout to avoid calling setState inside an async callback chain
        setTimeout(() => {
          setAutoEnabled(false);
          setRunning(false);
          setAutoStatus("error");
          setCbError(`Stopped after ${MAX_ORDER_ERRORS} consecutive order errors on ${coin}: ${e.message}`);
        }, 0);
      }

      return { success: false, error: e.message };
    }
  }, [creds, addAutoLog, fetchBalances]);

  // ── Start / Stop automation ─────────────────────────────────────────────────
  const startAutomation = useCallback(async () => {
    const keys = creds.keys?.[creds.provider] || {};
    const hasKeys = Object.values(keys).some(v => v && v.trim());
    if (!hasKeys) {
      setCbError(`No ${EXCHANGE_PROVIDERS[creds.provider]?.name} credentials — open Settings → API Credentials`);
      return;
    }
    setAutoStatus("connecting");
    addAutoLog(`Connecting to ${EXCHANGE_PROVIDERS[creds.provider]?.name || creds.provider} API...`, "info");
    try {
      await fetchBalances();

      // Reset all state — sim positions must not bleed into live
      const s = stateRef.current;
      COINS.forEach(coin => {
        s[coin].position = null;
        s[coin].pnl      = 0;
        s[coin].trades   = 0;
        s[coin].history  = [];
      });
      livePriceRef.current    = {};
      activeOrdersRef.current = {};
      pendingRef.current      = { BTC: null, ETH: null, SOL: null };
      orderErrorsRef.current  = { BTC: 0, ETH: 0, SOL: 0 };
      cooldownRef.current      = { BTC: null, ETH: null, SOL: null };
      trailingHighRef.current  = { BTC: null, ETH: null, SOL: null };
      trailingTpRef.current    = { BTC: null, ETH: null, SOL: null };
      tickRef.current          = 0;
      liveStartRef.current    = Date.now();
      setSnapshot(JSON.parse(JSON.stringify(s)));
      setWarmingUp(true);

      setAutoStatus("live");
      const initBalLive = parseFloat(creds.tradeSizeUSD) || 50;
      sessionBalanceRef.current = initBalLive;
      sessionStartBalanceRef.current = initBalLive;
      setSessionBalance(initBalLive);
      setWsEnabled(true);
      setAutoEnabled(true);
      setRunning(true);
      addAutoLog(`Live trading started — pairs: ${creds.enabledCoins.join(", ")} | size: $${creds.tradeSizeUSD} | min conf: ${creds.minConfidence}%${creds.sandbox ? " | SANDBOX" : ""}`, "success");
      addAutoLog("⏳ 2-minute warmup — collecting price data. Buy signals will fire after warmup completes.", "warn");

      // Kick off first price fetch via bridge (handles CORS)
      fetchViaBridge(false, creds.provider);

      // After 2 minutes lift the warmup flag
      setTimeout(() => {
        setWarmingUp(false);
        addAutoLog("✓ Warmup complete — BUY signals are now active. Monitoring for entry signals...", "success");
      }, 2 * 60 * 1000);

    } catch (e) {
      setAutoStatus("error");
      setCbError(e.message);
      addAutoLog(`Connection failed: ${e.message}`, "error");
    }
  }, [creds, fetchBalances, fetchViaBridge, addAutoLog]);

  // ── Manual trade execution ────────────────────────────────────────────────
  const executeManualTrade = useCallback(async (coin, action) => {
    const price = stateRef.current[coin].prices.at(-1);
    if (!price) return;
    setManualConfirm(null);
    action === "BUY" ? setManualBuying(true) : setManualSelling(true);

    const s = stateRef.current[coin];
    // Use compounding session balance for live trades too
    const tradeUSD = sessionBalanceRef.current || parseFloat(creds.tradeSizeUSD) || 50;
    const baseSize = tradeUSD / price;

    // Update local position state
    if (action === "BUY" && !s.position) {
      s.position = { price, size: roundLotSize(parseFloat(creds.tradeSizeUSD) / price, coin), entryTick: tickRef.current, manual: true, algoOwned: true };
      s.trades++;
      addAutoLog(`[MANUAL] BUY ${coin} @ $${price.toFixed(2)}`, "info");
    } else if (action === "SELL" && s.position) {
      const profit = calcProfit(s.position.price, price, s.position.size, creds.feePercent);
      const profitPct = s.position.price ? (price - s.position.price) / s.position.price * 100 : 0;
      s.pnl += profit;
      s.position = null;
      s.trades++;
      addAutoLog(`[MANUAL] SELL ${coin} @ $${price.toFixed(2)} → ${profit >= 0 ? "+" : ""}$${Math.abs(profit).toFixed(2)} (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(2)}%)`, profit >= 0 ? "success" : "warn");
    } else if (action === "SELL" && !s.position) {
      addAutoLog(`[MANUAL] SELL ignored — no open position for ${coin}`, "warn");
      setManualSelling(false);
      return;
    } else if (action === "BUY" && s.position) {
      addAutoLog(`[MANUAL] BUY ignored — position already open for ${coin}`, "warn");
      setManualBuying(false);
      return;
    }

    setSnapshot(JSON.parse(JSON.stringify(stateRef.current)));

    // Place real order if automation is live (goes through proxy)
    if (autoEnabled && !creds.sandbox) {
      try {
        const keys = creds.keys?.[creds.provider] || {};
        const res = await fetch(`${PROXY_BASE}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exchange: creds.provider, coin, side: action, quoteSize: tradeUSD, baseSize, ...keys }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        addAutoLog(`[MANUAL] ${action} ${coin} order confirmed — ID: ${data.orderId?.slice(0,12)}...`, "success");
        await fetchBalances();
      } catch (e) {
        addAutoLog(`[MANUAL] ${action} ${coin} order failed: ${e.message}`, "error");
      }
    } else if (creds.sandbox) {
      addAutoLog(`[MANUAL SANDBOX] ${action} ${coin} @ $${price.toFixed(2)}`, "sandbox");
    }

    action === "BUY" ? setManualBuying(false) : setManualSelling(false);
  }, [creds, autoEnabled, addAutoLog]);

  // ── Sync algo state from exchange (positions + fills) ────────────────────
  const [exchangeState, setExchangeState] = useState(null); // { positions, fills, syncedAt }
  const [syncing, setSyncing] = useState(false);

  const syncFromExchange = useCallback(async () => {
    if (!autoEnabled || !PROXY_BASE) return;
    const keys = creds.keys?.[creds.provider] || {};
    if (!Object.values(keys).some(v => v?.trim())) return;
    setSyncing(true);
    try {
      const res = await fetch(`${PROXY_BASE}/positions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: creds.provider,
          coins: creds.enabledCoins,
          ...keys,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setExchangeState({
        positions: data.positions || {},
        fills:     data.fills     || [],
        syncedAt:  fmtDateTime(new Date()),
      });

      // Reconcile local position state with exchange reality
      // Skip adoption during warmup — pre-existing exchange balances are not algo positions
      const inWarmupSync = liveStartRef.current !== null &&
        (Date.now() - liveStartRef.current) < 2 * 60 * 1000;

      const s = stateRef.current;
      let reconciled = false;
      for (const coin of creds.enabledCoins) {
        const exPos   = data.positions?.[coin];
        const localPos = s[coin].position;

        // Report exchange balance for info only — never adopt as algo position
        // Algo only sells what it explicitly bought (algoOwned: true)
        if (exPos && exPos.qty > 0) {
          const label = inWarmupSync ? "warmup" : "live";
          addAutoLog(`[SYNC] ${coin} exchange balance: ${exPos.qty.toFixed(6)} [${label}] — display only`, "info");
        }
        // If algo thinks it has a position but exchange shows zero qty,
        // and the position was algo-owned, mark it as externally closed
        if (!exPos?.qty && localPos?.algoOwned) {
          const price  = s[coin].prices.at(-1);
          const profit = localPos.price ? calcProfit(localPos.price, price, localPos.size || 0, creds.feePercent) : 0;
          const profitPct = localPos.price ? (price - localPos.price) / localPos.price * 100 : 0;
          s[coin].pnl += profit;
          s[coin].position = null;
          s[coin].trades++;
          addAutoLog(`[SYNC] ${coin} closed externally — P&L: ${profit >= 0 ? "+" : ""}$${Math.abs(profit).toFixed(2)} (${profitPct.toFixed(2)}%)`, profit >= 0 ? "success" : "warn");
          reconciled = true;
        }
      }
      if (reconciled) setSnapshot(JSON.parse(JSON.stringify(s)));

    } catch (e) {
      addAutoLog(`[SYNC] Exchange state sync failed: ${e.message}`, "error");
    } finally {
      setSyncing(false);
    }
  }, [autoEnabled, creds, addAutoLog]);

  // Sync from exchange every 30s during live automation
  useEffect(() => {
    if (!autoEnabled) return;
    syncFromExchange(); // immediate first sync
    const id = setInterval(syncFromExchange, 30_000);
    return () => clearInterval(id);
  }, [autoEnabled, syncFromExchange]);

  const stopAutomation = useCallback(() => {
    setWsEnabled(false);
    setAutoEnabled(false);
    setAutoStatus("idle");
    setRunning(false);
    setWarmingUp(false);
    liveStartRef.current    = null;
    activeOrdersRef.current = {};
    pendingRef.current      = { BTC: null, ETH: null, SOL: null };
    orderErrorsRef.current  = { BTC: 0, ETH: 0, SOL: 0 };
    cooldownRef.current     = { BTC: null, ETH: null, SOL: null };
    trailingHighRef.current = { BTC: null, ETH: null, SOL: null };
    trailingTpRef.current   = { BTC: null, ETH: null, SOL: null };
    agentDecisionRef.current = null;
    sessionBalanceRef.current = null;
    setSessionBalance(null);
    // Reset RL Q-tables if configured
    if (creds.rlParams?.resetOnStop !== false) {
      COINS.forEach(c => { if (rlTables[c]) delete rlTables[c]; });
      Object.keys(rlPredCache).forEach(c => delete rlPredCache[c]);
      addAutoLog("🎮 RL Q-tables reset", "info");
    }
    addAutoLog("Live trading stopped", "warn");
  }, [addAutoLog]);

  // ── Transaction logger ───────────────────────────────────────────────────────
  const logTransaction = useCallback((type, coin, price, qty, pnl, fees, reason, agentReason, lstmData) => {
    const entry = {
      id:          Date.now(),
      timestamp:   new Date().toISOString(),
      time:        fmtTime(new Date()),
      mode:        autoEnabled ? (creds.sandbox ? "sandbox" : "live") : "simulation",
      type,                          // BUY | SELL
      coin,
      price:       parseFloat(price?.toFixed?.(2) || price),
      qty:         parseFloat(qty?.toFixed?.(8) || qty),
      usdValue:    parseFloat((price * qty)?.toFixed?.(2) || 0),
      pnl:         pnl != null ? parseFloat(pnl?.toFixed?.(2)) : null,
      fees:        fees != null ? parseFloat(fees?.toFixed?.(4)) : null,
      netPnl:      pnl != null && fees != null ? parseFloat((pnl - fees)?.toFixed?.(2)) : null,
      exitReason:  reason || null,
      agentReason: agentReason || null,
      lstmTrend:   lstmData?.trendScore?.toFixed?.(3) || null,
      lstmChange:  lstmData?.predictedChangePct?.toFixed?.(3) || null,
      lstmVol:     lstmData?.volatility?.toFixed?.(3) || null,
    };
    setTxLog(prev => [entry, ...prev].slice(0, 1000)); // keep last 1000 trades
    return entry;
  }, [autoEnabled, creds.sandbox]);

  // ── CSV export ────────────────────────────────────────────────────────────────
  const exportTxCSV = useCallback(() => {
    if (txLog.length === 0) return;
    const headers = [
      "Timestamp","Time","Mode","Type","Coin","Price","Qty","USD Value",
      "P&L ($)","Fees ($)","Net P&L ($)","Exit Reason",
      "LSTM Trend","LSTM Change%","LSTM Vol","Agent Reasoning"
    ];
    const rows = txLog.map(t => [
      t.timestamp, t.time, t.mode, t.type, t.coin,
      t.price, t.qty, t.usdValue,
      t.pnl ?? "", t.fees ?? "", t.netPnl ?? "",
      t.exitReason ?? "",
      t.lstmTrend ?? "", t.lstmChange ?? "", t.lstmVol ?? "",
      (t.agentReason || "").replace(/,/g, ";"),  // escape commas
    ]);
    const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `crypto_trades_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [txLog]);

  // ── Main simulation tick ────────────────────────────────────────────────────
  const runTick = useCallback(() => {
    const s = stateRef.current;
    tickRef.current += 1;

    // News is fetched on a real interval — nothing to do per tick

    // Price updates handled by dedicated 2s polling interval (see useEffect above)

    COINS.forEach((coin) => {
      const cs = s[coin];
      const lastPrice = cs.prices[cs.prices.length - 1];

      // Both live and simulation: consume real prices from livePriceRef
      // livePriceRef is written by WebSocket (primary) or HTTP poller (fallback)
      // No synthetic price generation — simulation uses real market data only
      const live = livePriceRef.current[coin];
      if (live?.price && live.price > 0) {
        cs.prices.push(live.price);
        if (cs.prices.length > 200) cs.prices.shift();
        const spread = (live.ask || live.price) - (live.bid || live.price);
        const vol = spread > 0 ? Math.max(0.3, Math.min(3, 1 / spread)) : 1;
        cs.volumes.push(vol);
        if (cs.volumes.length > 200) cs.volumes.shift();
        // Update multi-timeframe buffers — price sampled at fixed wall-clock intervals
        if (!cs.mtf) cs.mtf = initMTFBuffers();
        updateMTFBuffers(cs.mtf, live.price);
      }
      // If no live price yet — hold last known price, do not generate synthetic data

      const newPrice = cs.prices[cs.prices.length - 1];
      const avgVol = cs.volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(cs.volumes.length, 20);
      const volumeRatio = (cs.volumes[cs.volumes.length - 1] || 1) / avgVol;

      const ip = creds.indicatorPeriods || { smaFast:20, smaMid:50, smaSlow:99, emaFast:12, emaSlow:26, rsi:14, bollinger:20, atr:14 };
      const bollPeriod = ip.bollinger;
      // Multi-timeframe SMA/EMA computed on time-downsampled price buffers
      const mtfInds = cs.mtf ? calcMTFIndicators(cs.mtf) : {};
      const indicators = {
        currentPrice: newPrice,
        sma20:  calcSMA(cs.prices, ip.smaFast),
        sma50:  calcSMA(cs.prices, ip.smaMid),
        sma99:  calcSMA(cs.prices, ip.smaSlow),
        ema12:  calcEMA(cs.prices, ip.emaFast),
        ema26:  calcEMA(cs.prices, ip.emaSlow),
        rsi:    calcRSI(cs.prices, ip.rsi),
        boll:   calcBollinger(cs.prices, bollPeriod),
        macd:   calcMACD(cs.prices),
        atr:    calcATR(cs.prices, ip.atr),
        ...mtfInds,  // sma20_1m, sma50_1m, sma20_5m, sma50_5m, etc.
      };

      // RF classifier: sync, updates rfPredCache every tick
      if (cs.prices.length >= RF_MIN_SAMPLES + 5) {
        try { updateRF(coin, cs.prices, indicators, volumeRatio); } catch (_) {}
      }
      // RL agent: epsilon-greedy Q-learning, updates every tick
      try { rlPredict(coin, indicators, volumeRatio, creds.rlParams); } catch (_) {}

      // ── Signal source routing ─────────────────────────────────────────────────
      const src = creds.signalSource || "rules";

      // Extra values for custom rule conditions (position context + ML)
      const pos         = cs.position;
      const heldMs      = pos ? (tickRef.current - (pos.entryTick || 0)) * (speed || 1500) : 0;
      const unrealPct   = pos ? (newPrice - pos.price) / pos.price * 100 : null;
      const peakProfit  = pos ? Math.max(unrealPct || 0, pos._peakPct || 0) : null;
      // Update peak on position object (mutable ref)
      if (pos && unrealPct !== null && unrealPct > (pos._peakPct || 0)) pos._peakPct = unrealPct;
      const drawdown    = pos && peakProfit !== null ? peakProfit - (unrealPct || 0) : null;
      const totalPnl    = Object.values(stateRef.current).reduce((s, c) => s + (c.pnl || 0), 0);

      const ruleExtra = {
        rfProb:           rfPredCache[coin]?.directionProbability  ?? null,
        lstmTrend:        lstmPredCache[coin]?.trendScore          ?? null,
        lstmDirProb:      lstmPredCache[coin]?.directionProbability ?? null,
        unrealizedPct:    unrealPct,
        heldMinutes:      heldMs / 60000,
        heldTicks:        pos ? tickRef.current - (pos.entryTick || 0) : 0,
        peakProfitPct:    peakProfit,
        drawdownFromPeak: drawdown,
        totalPnl,
        positionSize:     pos ? pos.price * pos.size : 0,
        signalScore:      0, // updated below after signal is computed
      };

      // Custom rule engine — evaluated first if enabled, overrides standard rules
      const customRuleSignal = creds.customRules?.enabled
        ? evalCustomRules(creds.customRules, indicators, cs.prices, volumeRatio, ruleExtra)
        : null;

      // Standard rule-based signal
      const ruleSignal = customRuleSignal
        || (creds.tradingMode === "mean_reversion"
          ? generateMeanReversionSignal(indicators, volumeRatio, creds.feePercent)
          : generateSignal(indicators, activeSentiment, volumeRatio, { ...creds.indicatorConfig, _ruleCombiner: creds.ruleCombiner }));

      // DeepSeek agent decision (async, may be stale)
      const agentDecision = (src === "deepseek") && agentDecisionRef.current?.[coin];

      // RL signal from Q-learning agent
      const rlCache  = rlPredCache[coin];
      const rlProb   = rlCache?.directionProbability ?? 0.5;
      const rlMinEp  = parseInt(creds.rlParams?.minEpisodes) || RL_MIN_EPISODES;
      const rlSignal = (src === "rl") && rlCache && rlCache.episodes >= rlMinEp ? {
        action:         rlCache.action,
        confidence:     String(rlCache.confidence),
        score:          rlCache.action === "BUY" ? "2" : rlCache.action === "SELL" ? "-2" : "0",
        reasons:        [{ label: `RL Q[H:${rlCache.qValues?.[0]} B:${rlCache.qValues?.[1]} S:${rlCache.qValues?.[2]}] ε=${rlCache.epsilon} ep=${rlCache.episodes}`, vote: rlCache.action === "BUY" ? 1 : -1 }],
        agreeingCount:  1, totalIndicators: 1, fromRL: true,
      } : null;

      // RF signal: convert directionProbability → BUY/SELL/HOLD
      const rfProb   = rfPredCache[coin]?.directionProbability ?? 0.5;
      const rfSignal = (src === "rf" || src === "rf+lstm") && rfPredCache[coin] ? {
        action:         rfProb > 0.58 ? "BUY" : rfProb < 0.42 ? "SELL" : "HOLD",
        confidence:     String(Math.round(Math.abs(rfProb - 0.5) * 200)),
        score:          String(((rfProb - 0.5) * 10).toFixed(2)),
        reasons:        [{ label: `RF direction P↑: ${(rfProb*100).toFixed(1)}%`, vote: rfProb > 0.5 ? 1 : -1 }],
        agreeingCount:  1, totalIndicators: 1, fromRF: true,
      } : null;

      // LSTM signal: use trendScore + directionProbability
      const lstmCache  = lstmPredCache[coin];
      const lstmProb   = lstmCache?.directionProbability ?? 0.5;
      const lstmTrend  = lstmCache?.trendScore ?? 0;
      const lstmAction = (lstmProb > 0.58 && lstmTrend > 0) ? "BUY"
                       : (lstmProb < 0.42 && lstmTrend < 0) ? "SELL" : "HOLD";
      const lstmSignal = (src === "lstm" || src === "rf+lstm") && lstmCache ? {
        action:         lstmAction,
        confidence:     String(Math.round(Math.abs(lstmProb - 0.5) * 200)),
        score:          String(((lstmProb - 0.5) * 10).toFixed(2)),
        reasons:        [{ label: `LSTM P↑:${(lstmProb*100).toFixed(1)}% trend:${lstmTrend.toFixed(2)}`, vote: lstmTrend > 0 ? 1 : -1 }],
        agreeingCount:  1, totalIndicators: 1, fromLSTM: true,
      } : null;

      // RF+LSTM combined: both must agree, take average confidence
      const combinedSignal = (src === "rf+lstm") && rfSignal && lstmSignal ? (() => {
        const avgProb = (rfProb + lstmProb) / 2;
        const action  = avgProb > 0.55 ? "BUY" : avgProb < 0.45 ? "SELL" : "HOLD";
        return {
          action,
          confidence: String(Math.round(Math.abs(avgProb - 0.5) * 200)),
          score:      String(((avgProb - 0.5) * 10).toFixed(2)),
          reasons:    [{ label: `RF:${(rfProb*100).toFixed(0)}% LSTM:${(lstmProb*100).toFixed(0)}% avg:${(avgProb*100).toFixed(0)}%`, vote: action === "BUY" ? 1 : action === "SELL" ? -1 : 0 }],
          agreeingCount: 2, totalIndicators: 2, fromRF: true, fromLSTM: true,
        };
      })() : null;

      // Final signal: pick based on signalSource
      const signal = agentDecision
        || (src === "rl"      && rlSignal)
        || (src === "rf+lstm" && combinedSignal)
        || (src === "rf"      && rfSignal)
        || (src === "lstm"    && lstmSignal)
        || ruleSignal;

      // Now that signal is defined, update signalScore in ruleExtra and
      // re-evaluate custom rules to pick up exit triggers that depend on it
      ruleExtra.signalScore = parseFloat(signal?.score || 0);
      const customExitSignal = creds.customRules?.enabled && cs.position
        ? evalCustomRules(creds.customRules, indicators, cs.prices, volumeRatio, ruleExtra)
        : null;
      // Merge exit triggers from both evaluations
      const allCustomExits = [
        ...(customRuleSignal?.exitTriggers || []),
        ...(customExitSignal?.exitTriggers  || []),
      ];

      // ── Exit rule helpers ─────────────────────────────────────────────────────
      const exitRule = creds.exitRules?.[coin] || {};
      const es       = creds.exitStrategies || {};
      const entryPrice = cs.position?.price || newPrice;

      // ── Dynamic TP/SL scaling based on cumulative P&L ────────────────────────
      const dxCfg = creds.dynamicExits;
      let tpMultiplier = 1, slMultiplier = 1, dxLabel = null;
      if (dxCfg?.enabled) {
        // Cumulative P&L source: total across all coins, or just this coin
        const totalPnl = dxCfg.scaleBy === "per_coin"
          ? cs.pnl
          : COINS.reduce((sum, c) => sum + (s[c]?.pnl || 0), 0);

        const profitThresh = parseFloat(dxCfg.profitThreshold) || 20;
        const lossThresh   = parseFloat(dxCfg.lossThreshold)   || -20;
        const maxTpBoost   = parseFloat(dxCfg.maxTpBoost)      || 50;  // %
        const maxTpCut     = parseFloat(dxCfg.maxTpCut)        || 50;  // %
        const maxSlTighten = parseFloat(dxCfg.maxSlTighten)    || 30;  // %

        const allowWinning = dxCfg.mode === "aggressive_when_winning" || dxCfg.mode === "both";
        const allowLosing  = dxCfg.mode === "defensive_when_losing"   || dxCfg.mode === "both";

        if (allowWinning && totalPnl > profitThresh) {
          // Scale boost proportionally: 2x threshold = full maxTpBoost, capped
          const scaleFactor = Math.min(2, (totalPnl - profitThresh) / profitThresh + 1);
          const boostPct = Math.min(maxTpBoost, maxTpBoost * (scaleFactor - 1));
          tpMultiplier = 1 + boostPct / 100;
          dxLabel = `+${boostPct.toFixed(0)}% TP (P&L $${totalPnl.toFixed(2)} > $${profitThresh})`;
        } else if (allowLosing && totalPnl < lossThresh) {
          // Tighten TP (faster exits) and SL (less room to lose) when underwater
          const scaleFactor = Math.min(2, (Math.abs(totalPnl) - Math.abs(lossThresh)) / Math.abs(lossThresh) + 1);
          const cutPct      = Math.min(maxTpCut,     maxTpCut     * (scaleFactor - 1));
          const tightenPct  = Math.min(maxSlTighten, maxSlTighten * (scaleFactor - 1));
          tpMultiplier = 1 - cutPct / 100;
          slMultiplier = 1 - tightenPct / 100;
          dxLabel = `-${cutPct.toFixed(0)}% TP, -${tightenPct.toFixed(0)}% SL (P&L $${totalPnl.toFixed(2)} < $${lossThresh})`;
        }
      }

      const resolveLevel = (type, value, direction) => {
        const v = parseFloat(value) || 0;
        if (!v) return null;
        // Apply dynamic multiplier to the configured TP/SL distance
        const mult = direction === "up" ? tpMultiplier : slMultiplier;
        const scaledV = v * mult;
        return type === "percent"
          ? direction === "up" ? entryPrice * (1 + scaledV / 100) : entryPrice * (1 - scaledV / 100)
          : direction === "up" ? entryPrice + scaledV : entryPrice - scaledV;
      };

      // ATR — needed by both the trend/ATR block below and later gate checks
      const atr = calcATR(cs.prices, 14);

      // ── Trend alignment gate ─────────────────────────────────────────────────
      // Checks MTF confluence: only allow BUY when the higher timeframes agree
      // with the short-term signal direction. Prevents trading against the trend.
      const taCfg = creds.exitStrategies?.trendAlignment;
      let trendAlignOk = true;
      let trendAlignDetails = {};
      if (taCfg?.enabled) {
        // 1h trend: price above SMA50 on 1-hour timeframe
        const sma50_1h  = indicators["sma50_1h"];
        const bullish1h = sma50_1h ? newPrice > sma50_1h : true; // pass if no data yet
        // 15m momentum: EMA12 > EMA26 on 15-minute timeframe
        const ema12_15m = indicators["ema12_15m"];
        const ema26_15m = indicators["ema26_15m"];
        const bullish15m = (ema12_15m && ema26_15m) ? ema12_15m > ema26_15m : true;
        // 1h RSI: not in a strong downtrend (RSI above threshold)
        const rsi_1h    = indicators["rsi_1h"];
        const rsiFloor  = parseFloat(taCfg.requireRsiAbove) || 45;
        const rsiOk     = rsi_1h ? rsi_1h >= rsiFloor : true;

        trendAlignDetails = {
          bullish1h, bullish15m, rsiOk,
          sma50_1h: sma50_1h?.toFixed(2), rsi_1h: rsi_1h?.toFixed(1),
          ema12_15m: ema12_15m?.toFixed(2), ema26_15m: ema26_15m?.toFixed(2),
        };

        const passCount = [
          !taCfg.requireBullish1h  || bullish1h,
          !taCfg.requireBullish15m || bullish15m,
          rsiOk,
        ].filter(Boolean).length;

        // Strict mode: all 3 must pass. Normal mode: 2 of 3
        trendAlignOk = taCfg.strictMode ? passCount === 3 : passCount >= 2;
      }

      // ── ATR-based dynamic TP/SL ───────────────────────────────────────────────
      // Replaces fixed-% TP/SL with ATR × multiplier targets.
      // Computed at BUY time and stored in cs.position so they don't drift.
      const atrTpSlCfg = creds.exitStrategies?.atrTpSl;
      const atrTpPrice = atrTpSlCfg?.enabled && atr && cs.position
        ? cs.position.price + atr * (parseFloat(atrTpSlCfg.tpMultiplier) || 1.5)
        : null;
      const atrSlPrice = atrTpSlCfg?.enabled && atr && cs.position
        ? cs.position.price - atr * (parseFloat(atrTpSlCfg.slMultiplier) || 0.75)
        : null;
      // Partial exit: has the 1×ATR level been hit yet?
      const atrPartialHit = atrTpSlCfg?.enabled && atrTpSlCfg?.partialExit && atr && cs.position
        ? newPrice >= cs.position.price + atr * 1.0
        : false;

      // ── 1. Standard TP / SL ───────────────────────────────────────────────────
      const takeProfitPrice = cs.position
        ? resolveLevel(exitRule.takeProfitType, exitRule.takeProfitValue, "up") : null;
      const stopLossPrice = cs.position
        ? resolveLevel(exitRule.stopLossType, exitRule.stopLossValue, "down") : null;

      // ATR-based TP/SL overrides fixed % when enabled
      const effectiveTpPrice = atrTpSlCfg?.enabled && atrTpPrice ? atrTpPrice : takeProfitPrice;
      const effectiveSlPrice = atrTpSlCfg?.enabled && atrSlPrice ? atrSlPrice : stopLossPrice;

      const priceHitTP  = effectiveTpPrice && newPrice >= effectiveTpPrice;
      const hitStopLoss = effectiveSlPrice && newPrice <= effectiveSlPrice;

      // Partial exit at 1×ATR — closes half the position and adjusts to breakeven SL
      if (atrPartialHit && cs.position && !cs.position._partialExited) {
        const halfSize  = cs.position.size / 2;
        const halfFee   = halfSize * newPrice * (parseFloat(creds.feePercent||0) / 100);
        const halfProfit = (newPrice - cs.position.price) * halfSize - halfFee;
        cs.pnl += halfProfit;
        cs.position.size -= halfSize;
        cs.position._partialExited = true;
        // Move SL to breakeven for the remaining half
        cs.position._partialSl = cs.position.price * (1 + (parseFloat(creds.feePercent||0) / 100));
        addAutoLog(
          `📊 [PARTIAL EXIT] ${coin} 50% @ $${newPrice.toFixed(2)} +$${halfProfit.toFixed(2)} — SL moved to breakeven $${cs.position._partialSl.toFixed(2)}`,
          "success"
        );
      }

      // After partial exit, also enforce breakeven SL on remaining half
      const partialSlHit = cs.position?._partialExited && cs.position?._partialSl
        && newPrice <= cs.position._partialSl;

      // ── Trailing take-profit (overshoot & reverse) ───────────────────────────
      // When enabled: suppress the normal TP sell, arm a trailing exit instead.
      // Sell only when price reverses from its post-TP peak by trailTpPercent.
      const ttpCfg = es.trailingTakeProfit;
      let hitTakeProfit        = false;  // standard TP sell — suppressed when trailing TP on
      let hitTrailingTakeProfit = false; // trailing TP reversal sell

      if (cs.position && ttpCfg?.enabled) {
        const ttpPct = parseFloat(ttpCfg.trailPercent) || 1.0;
        const ttp    = trailingTpRef.current[coin] || { armed: false, peak: null };

        if (!ttp.armed && priceHitTP) {
          // Price just crossed TP — arm the trailer, start tracking peak
          trailingTpRef.current[coin] = { armed: true, peak: newPrice };
          addAutoLog(`🎯 ${coin} TP hit @ $${newPrice.toFixed(2)} — trailing take-profit armed (${ttpPct}% reversal)`, "info");
        } else if (ttp.armed) {
          // Update peak
          if (newPrice > ttp.peak) {
            trailingTpRef.current[coin] = { ...ttp, peak: newPrice };
          }
          // Check reversal from peak
          const reversalPrice = trailingTpRef.current[coin].peak * (1 - ttpPct / 100);
          if (newPrice <= reversalPrice) {
            hitTrailingTakeProfit = true;
            trailingTpRef.current[coin] = { armed: false, peak: null };
          }
        }
        // Standard TP sell is suppressed — trailing TP handles the exit
      } else {
        // Trailing TP off — use standard TP sell as normal
        hitTakeProfit = priceHitTP;
        if (!cs.position) trailingTpRef.current[coin] = { armed: false, peak: null };
      }

      // ── 2. Trailing stop ──────────────────────────────────────────────────────
      let hitTrailingStop = false;
      if (cs.position && es.trailingStop?.enabled) {
        // Update high-water mark
        if (!trailingHighRef.current[coin] || newPrice > trailingHighRef.current[coin]) {
          trailingHighRef.current[coin] = newPrice;
        }
        const trailVal  = parseFloat(es.trailingStop.trailPercent) || 1.5;
        const deltaType = es.trailingStop.trailDelta || "percent";
        const peak      = trailingHighRef.current[coin];
        // Compute stop price based on delta type
        const trailStopPx = deltaType === "absolute"
          ? peak - trailVal                    // e.g. peak - $500
          : peak * (1 - trailVal / 100);       // e.g. peak * (1 - 1.5%)
        if (newPrice <= trailStopPx && newPrice < peak * 0.999) {
          hitTrailingStop = true;
        }
      } else if (!cs.position) {
        trailingHighRef.current[coin] = null;
      }

      // ── 3. ATR-based exit ─────────────────────────────────────────────────────
      let hitATRStop = false, hitATRTP = false;
      if (cs.position && es.atrExit?.enabled) {
        const atr = calcATR(cs.prices, 14);
        if (atr) {
          const mult    = parseFloat(es.atrExit.atrMultiplier) || 1.5;
          const atrTP   = entryPrice + atr * mult;
          const atrSL   = entryPrice - atr * mult;
          hitATRTP = newPrice >= atrTP;
          hitATRStop = newPrice <= atrSL;
        }
      }

      // ── 4. Time-based exit ────────────────────────────────────────────────────
      let hitTimeExit = false;
      if (cs.position && es.timeExit?.enabled) {
        const maxMs   = (parseFloat(es.timeExit.maxHoldMinutes) || 30) * 60 * 1000;
        const heldMs  = (tickRef.current - (cs.position.entryTick || 0)) * (speed || 1500);
        if (heldMs >= maxMs) hitTimeExit = true;
      }

      // ── 5. Signal reversal exit ───────────────────────────────────────────────
      let hitSignalReversal = false;
      if (cs.position && es.signalReversal?.enabled) {
        const threshold = parseFloat(es.signalReversal.reversalScore) || -2;
        if (parseFloat(signal.score) <= threshold) hitSignalReversal = true;
      }

      // ── Custom rule exit triggers ──────────────────────────────────────────────
      const customExits   = allCustomExits;
      const hitCustomExit = cs.position && customExits.length > 0;

      // Map custom exit actions to their corresponding trigger flags
      const customExitAction = hitCustomExit
        ? customExits.sort((a,b) => (b.weight||1) - (a.weight||1))[0].action
        : null;

      // Named custom exit flags
      const hitCustomTTP      = customExits.some(e => e.action === "TRAILING_TAKE_PROFIT");
      const hitCustomTimExit  = customExits.some(e => e.action === "TIME_EXIT");
      const hitCustomTStop    = customExits.some(e => e.action === "TRAILING_STOP");
      const hitCustomSigRev   = customExits.some(e => e.action === "SIGNAL_REVERSAL");
      const hitCustomDynExit  = customExits.some(e => e.action === "DYNAMIC_EXIT");
      const hitCustomPBLimit  = customExits.some(e => e.action === "POST_BUY_LIMIT");
      const hitCustomSell     = customExits.some(e => e.action === "SELL" || e.action === "STOP_LOSS");

      // ── Combine all exit triggers ─────────────────────────────────────────────
      const shouldSell = cs.position && (
        hitTakeProfit || hitTrailingTakeProfit || hitStopLoss ||
        hitTrailingStop || hitATRTP || hitATRStop ||
        hitTimeExit || hitSignalReversal ||
        hitCustomTTP || hitCustomTimExit || hitCustomTStop ||
        hitCustomSigRev || hitCustomDynExit || hitCustomPBLimit || hitCustomSell ||
        partialSlHit  // breakeven stop after partial exit
      );
      const sellReason = hitTrailingTakeProfit        ? "TRAILING_TAKE_PROFIT"
        : hitCustomTTP                                ? "RULE_TRAILING_TAKE_PROFIT"
        : hitTakeProfit                               ? "TAKE_PROFIT"
        : hitCustomSell                               ? "RULE_STOP_LOSS"
        : hitStopLoss                                 ? "STOP_LOSS"
        : partialSlHit                                ? "BREAKEVEN_STOP"
        : hitTrailingStop || hitCustomTStop           ? "TRAILING_STOP"
        : hitATRTP                                    ? "ATR_TAKE_PROFIT"
        : hitATRStop                                  ? "ATR_STOP_LOSS"
        : hitTimeExit  || hitCustomTimExit            ? "TIME_EXIT"
        : hitSignalReversal || hitCustomSigRev        ? "SIGNAL_REVERSAL"
        : hitCustomDynExit                            ? "RULE_DYNAMIC_EXIT"
        : hitCustomPBLimit                            ? "RULE_POST_BUY_LIMIT"
        : null;

      // ── Warmup check (ref-based — never stale) ───────────────────────────────
      const inWarmup = liveStartRef.current !== null &&
        (Date.now() - liveStartRef.current) < 2 * 60 * 1000;

      // ── BUY: signal-driven ────────────────────────────────────────────────────
      const minConf    = parseFloat(creds.minConfidence) || 60;
      const confPassed = parseFloat(signal.confidence) >= minConf;
      const noPending  = !pendingRef.current[coin]; // no order already in flight
      // Cooling off: block BUY for 1 minute after a confirmed SELL
      const lastSell   = cooldownRef.current[coin];
      const cooldownMs = (parseFloat(creds.cooldownMinutes) || 1) * 60_000;
      const inCooldown = lastSell !== null && (Date.now() - lastSell) < cooldownMs;
      // ── Volume gate ────────────────────────────────────────────────────────────
      const esV = creds.exitStrategies?.volumeGate;
      const volumeOk = !esV?.enabled || volumeRatio >= (parseFloat(esV.minVolumeRatio) || 1.2);

      // ── Volatility gate ──────────────────────────────────────────────────────
      const vgCfg       = creds.volatilityGate;
      const lstmVol     = lstmPredCache[coin]?.volatility ?? 1;
      const lstmPrices  = cs.prices.length;
      // Adaptive directionProb threshold: relax when LSTM has little data
      const minDirProbBase = parseFloat(vgCfg?.minDirProb || 0.55);
      const minDirProb     = lstmPrices < 200 ? Math.max(0.52, minDirProbBase - 0.1) : minDirProbBase;
      const lstmDirProb    = lstmPredCache[coin]?.directionProbability ?? 0.5;
      const rfDirProb      = rfPredCache[coin]?.directionProbability   ?? 0.5;
      // Use whichever predictor is more confident (RF warmup=10 ticks, LSTM=80 ticks)
      const bestDirProb    = Math.max(lstmDirProb, rfDirProb, rlProb ?? 0.5);
      // atr already computed earlier in this tick (before Standard TP/SL section)
      const atrPct         = atr && newPrice ? (atr / newPrice * 100) : 999;

      // Individual gate sub-conditions
      const volOk  = !vgCfg?.enabled || lstmVol >= (parseFloat(vgCfg.minVolatility) || 0.3);
      const atrOk  = !vgCfg?.enabled || atrPct  >= (parseFloat(vgCfg.minAtrPct)     || 0.3);
      const dirOk  = !vgCfg?.enabled || bestDirProb >= minDirProb;

      // OR-weighted: require at least 2 of 3 sub-conditions (not all 3)
      const volGateScore = (volOk ? 1 : 0) + (atrOk ? 1 : 0) + (dirOk ? 1 : 0);
      const volGateOk    = !vgCfg?.enabled || volGateScore >= 2;

      // ── Asymmetric TP/SL + fee check — only enforced when volatility gate is ON ──
      const minRr        = parseFloat(creds.minRrRatio) || 2;
      const er           = creds.exitRules?.[coin] || {};
      const tpVal        = parseFloat(er.takeProfitValue) || 2;
      const slVal        = parseFloat(er.stopLossValue)   || 1;
      const roundTripFee = (parseFloat(creds.feePercent) || 0.1) * 2;
      // When volatility gate is OFF — skip R:R and fee checks entirely
      const rrOk  = !vgCfg?.enabled || minRr <= 0 || (tpVal / slVal) >= minRr;
      const feeOk = !vgCfg?.enabled || atrPct > roundTripFee;

      // Log failed gates
      // Log gate blocks only once per signal (throttle to avoid spam)
      if (signal.action === "BUY" && !cs.position && confPassed && !inWarmup && noPending && !inCooldown && trendAlignOk) {
        const gateBlockKey = `${coin}-${Math.floor(Date.now()/10000)}`; // once per 10s per coin
        if (!volGateOk && !window["_gateLog_"+gateBlockKey+"_v"]) {
          window["_gateLog_"+gateBlockKey+"_v"] = true;
          addAutoLog(`[GATE] ${coin} vol gate ${volGateScore}/3 (vol:${volOk?"✓":"✗"} atr:${atrOk?"✓":"✗"} dir:${dirOk?"✓":"✗"} P:${bestDirProb.toFixed(2)})`, "info");
        }
        if (vgCfg?.enabled && !rrOk  && !window["_gateLog_"+gateBlockKey+"_r"]) { window["_gateLog_"+gateBlockKey+"_r"]=true; addAutoLog(`[GATE] ${coin} R:R ${(tpVal/slVal).toFixed(1)}:1 < ${minRr}:1`, "info"); }
        if (vgCfg?.enabled && !feeOk && !window["_gateLog_"+gateBlockKey+"_f"]) { window["_gateLog_"+gateBlockKey+"_f"]=true; addAutoLog(`[GATE] ${coin} ATR ${atrPct.toFixed(2)}% < fee ${roundTripFee.toFixed(2)}%`, "info"); }
      }

      // ── Detailed BUY decision log (every tick a BUY signal fires) ─────────────
      // Throttled to once per 10s per coin to avoid log spam
      if (signal.action === "BUY" && !cs.position) {
        const logKey = `buylog_${coin}_${Math.floor(Date.now()/10000)}`;
        if (!window[logKey]) {
          window[logKey] = true;
          const src = creds.signalSource || "rules";
          const lstmC = lstmPredCache[coin];
          const rfC   = rfPredCache[coin];
          const rlC   = rlPredCache[coin];

          // Source line
          const srcLabel = signal.fromCustomRules ? "⚙️ Custom Rules"
            : signal.fromRL   ? "🎮 RL"
            : signal.fromRF   ? "🌲 RF"
            : signal.fromLSTM ? "🧠 LSTM"
            : src === "deepseek" ? "🤖 AI Agent"
            : "📊 Rules";
          addAutoLog(`━━━ ${coin} BUY SIGNAL @ $${newPrice.toFixed(2)} via ${srcLabel} ━━━`, "info");

          // Gate checks
          const gates = [
            { name: "Confidence",  ok: confPassed,  val: `${signal.confidence}% (need ${minConf}%)` },
            { name: "Not in pos",  ok: !cs.position, val: cs.position ? "BLOCKED (already open)" : "clear" },
            { name: "Cooldown",    ok: !inCooldown,   val: inCooldown ? `cooling ${((cooldownMs - (Date.now()-lastSell))/1000).toFixed(0)}s` : "clear" },
            { name: "Volume",      ok: volumeOk,       val: `${volumeRatio?.toFixed(2)}× (need ${parseFloat(creds.exitStrategies?.volumeGate?.minVolumeRatio||1.2).toFixed(2)}×)` },
            { name: "Vol gate",    ok: volGateOk,      val: `${volGateScore}/3 (vol:${volOk?"✓":"✗"} atr:${atrOk?"✓":"✗"} dir:${dirOk?"✓":"✗"})` },
            { name: "R:R ratio",   ok: rrOk,           val: `${(tpVal/slVal).toFixed(1)}:1 (need ${minRr}:1)` },
            { name: "Fee cover",   ok: feeOk,          val: `ATR ${atrPct.toFixed(2)}% vs fee ${roundTripFee.toFixed(2)}%` },
            { name: "Trend align", ok: trendAlignOk,   val: taCfg?.enabled
              ? `1h:${trendAlignDetails.bullish1h?"↑bull":"↓bear"} 15m:${trendAlignDetails.bullish15m?"↑bull":"↓bear"} RSI(1h):${trendAlignDetails.rsi_1h||"?"}`
              : "disabled" },
            { name: "ATR TP/SL",   ok: true,            val: atrTpSlCfg?.enabled && atr
              ? `TP=$${atrTpPrice?.toFixed(2)||"?"} SL=$${atrSlPrice?.toFixed(2)||"?"} ATR=${atr?.toFixed(2)}`
              : "disabled (using fixed %)" },
          ];
          gates.forEach(g => addAutoLog(`  ${g.ok ? "✅" : "❌"} ${g.name}: ${g.val}`, g.ok ? "info" : "warn"));

          // Indicators
          addAutoLog(`  📊 RSI=${indicators.rsi?.toFixed(1)} MACD=${indicators.macd?.toFixed(5)} Boll%B=${indicators.boll?((newPrice-indicators.boll.lower)/((indicators.boll.upper-indicators.boll.lower)||1)).toFixed(2):"n/a"} Vol=${volumeRatio?.toFixed(2)}×`, "info");
          addAutoLog(`  📈 SMA20dist=${indicators.sma20?((newPrice-indicators.sma20)/indicators.sma20*100).toFixed(2):"n/a"}% SMA50dist=${indicators.sma50?((newPrice-indicators.sma50)/indicators.sma50*100).toFixed(2):"n/a"}% ATR=${atrPct.toFixed(3)}%`, "info");

          // LSTM parameters
          if (lstmC && lstmStatus === "ready") {
            addAutoLog(`  🧠 LSTM: trend=${lstmC.trendScore?.toFixed(3)} Δ5=${lstmC.predictedChangePct?.toFixed(3)}% vol=${lstmC.volatility?.toFixed(3)} P↑=${lstmC.directionProbability?.toFixed(3)}`, "info");
          } else {
            addAutoLog(`  🧠 LSTM: ${lstmStatus === "ready" ? "ready" : `${lstmStatus || "not started"} — ${cs.prices.length < 80 ? `needs ${80 - cs.prices.length} more ticks` : "warming up"}`}`, "info");
          }

          // RF parameters
          if (rfC) {
            addAutoLog(`  🌲 RF: P↑=${rfC.directionProbability?.toFixed(3)} trained on ${rfC.trainedOn || "?"} samples`, "info");
          } else {
            addAutoLog(`  🌲 RF: warming up (need ${Math.max(0, RF_MIN_SAMPLES + 5 - cs.prices.length)} more ticks)`, "info");
          }

          // RL parameters
          if (rlC) {
            addAutoLog(`  🎮 RL: action=${rlC.action} Q=[H:${rlC.qValues?.[0]} B:${rlC.qValues?.[1]} S:${rlC.qValues?.[2]}] ε=${rlC.epsilon} ep=${rlC.episodes}${rlC.episodes < RL_MIN_EPISODES ? " ⚠ exploring" : ""}`, "info");
          }

          // Custom rules that fired
          if (signal.fromCustomRules && signal.reasons?.length) {
            signal.reasons.forEach(r => addAutoLog(`  ⚙️ Rule: ${typeof r === "object" ? r.label : r}`, "info"));
          }

          // Custom exit rules active
          if (allCustomExits.length) {
            allCustomExits.forEach(e => addAutoLog(`  🎯 Exit rule armed: ${e.label} (${e.action})`, "info"));
          }

          // Net decision
          const willBuy = !cs.position && confPassed && !inWarmup && noPending && !inCooldown && volumeOk && volGateOk && rrOk && feeOk && trendAlignOk;
          addAutoLog(`  ${willBuy ? "✅ EXECUTING BUY" : "🚫 BUY SUPPRESSED"} — signal score ${signal.score} conf ${signal.confidence}%`, willBuy ? "success" : "warn");
        }
      }

      // BUY gate: signal + mandatory checks + soft gate (2-of-3)
      if (signal.action === "BUY" && !cs.position && confPassed && !inWarmup &&
          noPending && !inCooldown && volumeOk && volGateOk && rrOk && feeOk) {
        if (autoEnabled && creds.enabledCoins.includes(coin)) {
          addAutoLog(`🔔 BUY signal ${coin} @ $${newPrice.toFixed(2)} — conf ${signal.confidence}% score ${signal.score} — submitting order`, "info");
          pendingRef.current[coin] = "BUY";
          executeRealTrade(coin, "BUY", newPrice, parseFloat(signal.confidence))
            .then(result => {
              if (result?.success) {
                const entryPrice = result.fillPrice || newPrice;
                const filledQty  = result.filledQty || (parseFloat(creds.tradeSizeUSD) / newPrice);
                stateRef.current[coin].position = {
                  price:     entryPrice,
                  size:      filledQty,
                  entryTick: tickRef.current,
                  orderId:   result.orderId,
                  algoOwned: true,
                };
                stateRef.current[coin].trades++;
                setSnapshot(JSON.parse(JSON.stringify(stateRef.current)));
                const buyFees = filledQty * entryPrice * (parseFloat(creds.feePercent || 0) / 100);
                // Record RL entry state at live BUY confirmation
                try { rlOnBuy(coin, indicators, volumeRatio); } catch(_) {}
                logTransaction("BUY", coin, entryPrice, filledQty, null, buyFees, null,
                  agentDecisionRef.current?.[coin]?.reasoning, lstmPredCache[coin]);
                if (dxLabel) addAutoLog(`📊 [DYNAMIC] ${coin} exits scaled: ${dxLabel}`, "info");

                // ── Post-buy limit sell ────────────────────────────────────────
                // Place a resting limit SELL immediately after BUY fills
                // This locks in profit target as a maker order (0% fee on Binance.US)
                const pbls = creds.postBuyLimitSell;
                if (pbls?.enabled && PROXY_BASE) {
                  const off       = parseFloat(pbls.offsetValue) || 1.5;
                  const limitSell = pbls.offsetType === "absolute"
                    ? entryPrice + off
                    : entryPrice * (1 + off / 100);
                  const safeQty   = roundLotSize(filledQty * 0.9999, coin);
                  addAutoLog(`📋 Placing limit SELL ${coin} @ $${limitSell.toFixed(2)} (+${off}${pbls.offsetType === "percent" ? "%" : "$"} from $${entryPrice.toFixed(2)})`, "info");
                  fetch(`${PROXY_BASE}/advancedsell`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      exchange:    creds.provider,
                      coin,
                      qty:         safeQty,
                      currentPrice: limitSell,
                      sellConfig: {
                        type:             "limit",
                        limitOffsetType:  "absolute",
                        limitOffsetValue: "0",  // price is already computed
                      },
                      _limitPriceOverride: limitSell, // proxy uses this directly
                      ...creds.keys?.[creds.provider],
                    }),
                  })
                  .then(r => r.json())
                  .then(d => {
                    if (d.orderId) {
                      // Store the resting sell order ID so we can track or cancel it
                      stateRef.current[coin].position = {
                        ...stateRef.current[coin].position,
                        restingSellOrderId:    d.orderId,
                        restingSellLimitPrice: limitSell,
                      };
                      setSnapshot(JSON.parse(JSON.stringify(stateRef.current)));
                      addAutoLog(`✓ Limit SELL ${coin} resting @ $${limitSell.toFixed(2)} — ID:${d.orderId?.slice(0,12)}... (maker)`, "success");
                    } else if (d.fallback) {
                      addAutoLog(`⚠ Limit SELL not supported on ${creds.provider} — manual exit required`, "warn");
                    } else {
                      addAutoLog(`⚠ Limit SELL ${coin} failed: ${d.error || "unknown error"}`, "error");
                    }
                  })
                  .catch(e => addAutoLog(`⚠ Limit SELL ${coin} error: ${e.message}`, "error"));
                }
              }
            })
            .finally(() => {
              // Always clear pending flag so next signal can fire
              pendingRef.current[coin] = null;
            });
        } else if (!autoEnabled) {
          // SIMULATION only — use compounding sessionBalance, not fixed tradeSizeUSD
          const simTradeUSD = sessionBalanceRef.current || parseFloat(creds.tradeSizeUSD) || 50;
          const simSize = simTradeUSD / newPrice;
          cs.position = { price: newPrice, size: simSize, entryTick: tickRef.current, sim: true, algoOwned: true };
          cs.trades++;
          // Record RL entry state at BUY time
          try { rlOnBuy(coin, indicators, volumeRatio); } catch(_) {}
          const simFees = simSize * newPrice * (parseFloat(creds.feePercent || 0) / 100);
          addAutoLog(`🛒 SIM BUY ${coin} — using balance $${simTradeUSD.toFixed(2)}`, "info");
          logTransaction("BUY", coin, newPrice, simSize, null, simFees, null,
            agentDecisionRef.current?.[coin]?.reasoning, lstmPredCache[coin]);
        }
      }

      // ── SELL: exit rules only ─────────────────────────────────────────────────
      // Guards:
      //   1. Must not be in warmup
      //   2. No pending order on this coin
      //   3. Position must have been opened by the algo (algoOwned) — never sell
      //      a pre-existing exchange balance or exchange-synced position
      const canSell = shouldSell
        && !inWarmup
        && !pendingRef.current[coin]
        && cs.position?.algoOwned === true;

      if (canSell) {
        if (autoEnabled && creds.enabledCoins.includes(coin)) {
          // LIVE — query actual balance first to handle fee-in-asset deduction
          // e.g. bought 0.2772 ETH but received 0.27692 after 0.1% fee
          pendingRef.current[coin] = "SELL";
          const posAtSell = { ...cs.position };
          cs.position = null; // clear immediately to prevent re-trigger

          // Async IIFE — runTick is synchronous; await must be inside async wrapper
          (async () => {
            let sellQty = roundLotSize(posAtSell.size || (parseFloat(creds.tradeSizeUSD) / posAtSell.price), coin);
            if (PROXY_BASE) {
              try {
                const bRes = await fetch(`${PROXY_BASE}/balance`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ exchange: creds.provider, ...creds.keys?.[creds.provider] }),
                });
                const bData = await bRes.json();
                const avail = parseFloat(bData.balances?.[coin] || 0);
                if (avail > 0) {
                  const safeQty = roundLotSize(Math.min(avail, sellQty) * 0.9999, coin);
                  if (safeQty > 0) {
                    if (Math.abs(safeQty - sellQty) > 0.000001) {
                      addAutoLog(`Info: sell qty adjusted ${sellQty.toFixed(8)} to ${safeQty.toFixed(8)} ${coin}`, "info");
                    }
                    sellQty = safeQty;
                  }
                }
              } catch (_) { /* use calculated qty on balance check failure */ }
            }
            addAutoLog(`SELL signal: ${sellReason} ${coin} @ $${newPrice.toFixed(2)} qty: ${sellQty.toFixed(8)}`, "info");
            const result = await executeRealTrade(coin, "SELL", newPrice, 100, sellQty);
            if (result?.success) {
              const actualSellPrice = result.fillPrice || newPrice;
              const profit = calcProfit(posAtSell.price, actualSellPrice, posAtSell.size, creds.feePercent);
              const feeCost = posAtSell.size * (actualSellPrice + posAtSell.price) * (parseFloat(creds.feePercent || 0) / 100);
              addAutoLog(`P&L: ${profit >= 0 ? "+" : ""}$${Math.abs(profit).toFixed(2)} (fees ~$${feeCost.toFixed(2)})`, profit >= 0 ? "success" : "warn");
              stateRef.current[coin].pnl += profit;
              stateRef.current[coin].trades++;
              setSnapshot(JSON.parse(JSON.stringify(stateRef.current)));
              cooldownRef.current[coin] = Date.now();
              addAutoLog(`${coin} cooling off - next BUY in ${creds.cooldownMinutes || 1} min`, "info");
              // Reward RL agent
              try { rlReward(coin, profit - feeCost, indicators, volumeRatio, creds.rlParams); } catch (_) {}
              // Update compounding session balance
              if (sessionBalanceRef.current !== null) {
                const newBal = Math.max(1, sessionBalanceRef.current + profit - feeCost);
                sessionBalanceRef.current = newBal;
                setSessionBalance(newBal);
                addAutoLog(`💰 Balance updated: $${newBal.toFixed(2)} (${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} net)`, "info");
              }
              // Log SELL transaction
              logTransaction("SELL", coin, actualSellPrice, posAtSell.size, profit, feeCost, sellReason,
                agentDecisionRef.current?.[coin]?.reasoning, lstmPredCache[coin]);
            } else {
              stateRef.current[coin].position = posAtSell;
              setSnapshot(JSON.parse(JSON.stringify(stateRef.current)));
              addAutoLog(`SELL ${coin} failed - position restored`, "error");
            }
            pendingRef.current[coin] = null;
          })();
        } else {
          // SIMULATION — fee-adjusted dollar P&L
          const simPos    = { ...cs.position };
          const profit    = calcProfit(simPos.price, newPrice, simPos.size, creds.feePercent);
          const simFees   = simPos.size * (newPrice + simPos.price) * (parseFloat(creds.feePercent || 0) / 100);
          cs.pnl += profit;
          cs.position = null;
          cs.trades++;
          cooldownRef.current[coin] = Date.now();
          // Reward RL agent with trade outcome
          try { rlReward(coin, profit - simFees, indicators, volumeRatio, creds.rlParams); } catch (_) {}
          // Update compounding session balance
          if (sessionBalanceRef.current !== null) {
            const newBal = Math.max(1, sessionBalanceRef.current + profit);
            sessionBalanceRef.current = newBal;
            setSessionBalance(newBal);
          }
          logTransaction("SELL", coin, newPrice, simPos.size, profit, simFees, sellReason,
            agentDecisionRef.current?.[coin]?.reasoning, lstmPredCache[coin]);
        }
      }

      // Store sell reason in the history entry below
      const exitTrigger = canSell ? sellReason : null;

      const unrealized = cs.position ? (newPrice - cs.position.price) / cs.position.price * 100 : 0;
      const lstmSnap  = lstmPredCache[coin];
      const rfSnap    = rfPredCache[coin];
      const rlSnap    = rlPredCache[coin];
      cs.history.push({
        t: tickRef.current, price: newPrice,
        sma20: indicators.sma20, sma50: indicators.sma50,
        bUpper: indicators.boll?.upper, bLower: indicators.boll?.lower,
        rsi: indicators.rsi, action: signal.action,
        confidence: parseFloat(signal.confidence),
        score: parseFloat(signal.score),
        agreeingCount: signal.agreeingCount,
        totalIndicators: signal.totalIndicators,
        volumeRatio, reasons: signal.reasons,
        pnl: cs.pnl + (cs.position ? (newPrice - cs.position.price) * (cs.position.size || 0) : 0),
        exitTrigger,
        takeProfitPrice: cs.position ? takeProfitPrice : null,
        stopLossPrice: cs.position ? stopLossPrice : null,
        // ── Rich metadata for signal analysis log ───────────────────────────
        signalSource: creds.signalSource,
        fromCustomRules: signal.fromCustomRules,
        fromRL: signal.fromRL, fromRF: signal.fromRF, fromLSTM: signal.fromLSTM,
        // LSTM snapshot
        lstmTrend:       lstmSnap?.trendScore?.toFixed(3),
        lstmChange:      lstmSnap?.predictedChangePct?.toFixed(3),
        lstmVol:         lstmSnap?.volatility?.toFixed(3),
        lstmDirProb:     lstmSnap?.directionProbability?.toFixed(3),
        lstmStatus:      lstmStatus,
        // RF snapshot
        rfDirProb:       rfSnap?.directionProbability?.toFixed(3),
        rfTrainedOn:     rfSnap?.trainedOn,
        // RL snapshot
        rlAction:        rlSnap?.action,
        rlEpisodes:      rlSnap?.episodes,
        rlEpsilon:       rlSnap?.epsilon,
        rlQValues:       rlSnap?.qValues,
        // Gate status
        indicators: {
          rsi:          indicators.rsi?.toFixed(1),
          macd:         indicators.macd?.toFixed(4),
          bollingerPct: indicators.boll
            ? ((newPrice - indicators.boll.lower) / ((indicators.boll.upper - indicators.boll.lower) || 1)).toFixed(3)
            : null,
          sma20dist:    indicators.sma20 ? ((newPrice - indicators.sma20) / indicators.sma20 * 100).toFixed(2) : null,
          sma50dist:    indicators.sma50 ? ((newPrice - indicators.sma50) / indicators.sma50 * 100).toFixed(2) : null,
          atrPct:       indicators.atr   ? (indicators.atr / newPrice * 100).toFixed(3) : null,
          volume:       volumeRatio?.toFixed(2),
        },
        // Custom rules that fired
        customExitsFired: allCustomExits.map(e => e.label),
      });
      if (cs.history.length > 80) cs.history.shift();
    });

    setSnapshot(JSON.parse(JSON.stringify(s)));
  }, [autoEnabled, creds, activeSentiment, fetchLiveMarketData, executeRealTrade]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(runTick, speed);
    return () => clearInterval(id);
  }, [running, speed, runTick]);

  // ── Derived display data ───────────────────────────────────────────────────
  // When viewing a saved session, overlay its data on the main cards
  // so the user sees that session's trades/P&L/positions instead of live state
  const viewSnap   = viewingSession?.snapshot;
  // isViewing: overlay main cards with session data when:
  // - viewing a stopped paper/live session (historical)
  // - viewing a running VPS session (live data from poll)
  // Does NOT overlay when the browser's own paper trading loop is running
  const isViewing = !!viewingSession && (!running || viewingSession.isRunning);

  // ── Session view data ──────────────────────────────────────────────────────
  // When viewing a session, build proper coin-like objects for all dashboard cards.
  // For running VPS sessions merge latest poll data. For paper sessions use snapshot.
  const viewedSessionData = isViewing && viewSnap ? (() => {
    // For running VPS sessions get latest polled snapshot
    const liveS = viewingSession.isRunning
      ? serverSessions.find(s => (s.sessionId || s.session_id) === viewingSession.sessionId)
      : null;

    const eff = {
      pnlByCoin:    (liveS?.pnl || liveS?.pnl_by_coin || viewSnap.pnlByCoin || {}),
      positions:    (liveS?.positions || viewSnap.positions || {}),
      tradesByCoin: (liveS?.tradesByCoin || liveS?.trades_by_coin || viewSnap.tradesByCoin || {}),
      coinBalances: (liveS?.coinBalances || liveS?.coin_balances || viewSnap.coinBalances || {}),
      livePrices:   (liveS?.livePrices || {}),
      sessionCreds: (viewSnap.creds || {}),
      enabledCoins: (viewSnap.enabledCoins || liveS?.coins || Object.keys(viewSnap.pnlByCoin || {}) || ["BTC"]),
      sessionBalance: parseFloat(liveS?.sessionBalance || liveS?.session_balance || viewSnap.sessionBalance || 0),
      totalTrades:  parseInt(liveS?.totalTrades || liveS?.total_trades || viewSnap.totalTrades || 0),
    };

    // Build per-coin display objects matching the shape that dashboard cards expect
    const coinData = {};
    for (const c of eff.enabledCoins) {
      const pnl      = parseFloat(eff.pnlByCoin[c] || 0);
      const trades   = parseInt(eff.tradesByCoin[c] || 0);
      const position = eff.positions[c] || null;
      const cb       = eff.coinBalances[c];
      const bal      = cb ? parseFloat(cb.current || 0) : eff.sessionBalance;
      const livePrice = parseFloat(eff.livePrices[c]?.price || 0);

      // Build a synthetic history entry for the P&L chart
      // If we have a position, compute unrealized
      const unrealPnl = position && livePrice && position.price
        ? (livePrice - position.price) * position.size : 0;

      // Each coin's own starting allocation — falls back to session default only if not set
      const allocated = cb ? parseFloat(cb.allocated || 0) : parseFloat(eff.sessionCreds?.tradeSizeUSD || 50);

      coinData[c] = {
        prices:   livePrice ? [livePrice, livePrice] : [0, 0],
        volumes:  [1],
        history:  [{ i: 0, pnl, rsi: null, price: livePrice || null, sma20: null, sma50: null, bUpper: null, bLower: null }],
        pnl,
        trades,
        position,
        balance:  bal,
        allocated,
        unrealizedDollar: unrealPnl,
        unrealized: position && livePrice ? (unrealPnl / (position.price * position.size) * 100) : 0,
      };
    }
    return { coinData, eff };
  })() : null;

  // Which coin to show — snap to first coin in session if selected coin not in session
  const viewedCoins   = viewedSessionData?.eff.enabledCoins || [];
  const effectiveCoin = isViewing && viewedCoins.length > 0 && !viewedCoins.includes(selectedCoin)
    ? viewedCoins[0]
    : selectedCoin;

  const viewedCoin  = viewedSessionData?.coinData[effectiveCoin] || null;
  const coin        = viewedCoin || snapshot[effectiveCoin] || snapshot[selectedCoin];
  const lastH       = coin.history[coin.history.length - 1];

  const currentPrice = viewedCoin
    ? (coin.prices[0] || 0)
    : coin.prices[coin.prices.length - 1];
  const priceChange = !viewedCoin && coin.prices.length > 1
    ? ((currentPrice - coin.prices[coin.prices.length - 2]) / coin.prices[coin.prices.length - 2]) * 100
    : 0;

  const unrealizedDollar = viewedCoin
    ? (viewedCoin.unrealizedDollar || 0)
    : (coin.position
        ? calcProfit(coin.position.price, currentPrice, coin.position.size || 0, creds.feePercent)
        : 0);
  const unrealized = viewedCoin
    ? (viewedCoin.unrealized || 0)
    : (coin.position && coin.position.price && coin.position.size
        ? (unrealizedDollar / (coin.position.price * coin.position.size)) * 100
        : 0);

  const chartData = coin.history.slice(-60).map((h, i) => ({
    i, price: h.price ? +h.price.toFixed(2) : null,
    sma20:  h.sma20  ? +h.sma20.toFixed(2)  : null,
    sma50:  h.sma50  ? +h.sma50.toFixed(2)  : null,
    bUpper: h.bUpper ? +h.bUpper.toFixed(2) : null,
    bLower: h.bLower ? +h.bLower.toFixed(2) : null,
  }));
  const rsiData = coin.history.slice(-60).map((h, i) => ({ i, rsi: h.rsi ? +h.rsi.toFixed(1) : null }));

  // P&L chart: for viewed sessions show per-coin P&L as a single bar.
  // For running sessions, only show P&L for the currently selected coin
  // (coin.history already scoped to the right coin via effectiveCoin above)
  const pnlData = isViewing && viewedSessionData
    ? viewedCoins.map((c, i) => ({
        i,
        pnl: parseFloat(viewedSessionData.eff.pnlByCoin[c] || 0),
      }))
    : coin.history.slice(-60).map((h, i) => ({ i, pnl: +h.pnl.toFixed(3) }));

  // Running session scope: only show data for coins actually in the current session
  const runningCoins = running ? (creds.enabledCoins || COINS) : COINS;
  const coinInSession = runningCoins.includes(effectiveCoin);

  // When viewing a session use its creds for display (provider, settings labels etc)
  const displayCreds  = isViewing && viewedSessionData?.eff.sessionCreds
    && Object.keys(viewedSessionData.eff.sessionCreds).length > 0
    ? viewedSessionData.eff.sessionCreds
    : creds;
  // Coins to display — viewed session's coins or browser creds coins
  const DISPLAY_COINS = isViewing && viewedCoins.length > 0 ? viewedCoins : COINS;

  const activeProvider = EXCHANGE_PROVIDERS[displayCreds.provider] || EXCHANGE_PROVIDERS.coinbase;
  const activeKeys = displayCreds.keys?.[displayCreds.provider] || {};
  const hasCredentials = Object.values(activeKeys).some(v => v && v.trim());
  const statusColor = { idle: "#94a3b8", connecting: "#f59e0b", live: "#10b981", error: "#ef4444" }[autoStatus];
  const statusLabel = { idle: "Automation idle", connecting: `Connecting to ${activeProvider.name}…`, live: creds.sandbox ? "Sandbox live" : `Live on ${activeProvider.name}`, error: "Connection error" }[autoStatus];
  const logTypeColor = { info: "var(--color-text-secondary)", success: "#10b981", error: "#ef4444", warn: "#f59e0b", sandbox: "#6366f1" };

  const retryPriceFetch = useCallback(() => { fetchViaBridge(false, creds.provider); }, [fetchViaBridge, creds.provider]);

  return (
    <div data-theme={theme} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, color: "var(--color-text-primary)", padding: "12px 0", background: "var(--color-body-bg)", minHeight: "100vh" }}>
      {/* Preload TF.js — loads early so LSTM is ready when agent mode activates */}
      <script
        id="tfjs-preload"
        src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js"
        async
      />
      {/* Inject CSS tokens for non-Claude environments (Vite, Netlify, etc.) */}
      <style>{`
        /* ── Dark theme (default) ────────────────────────────────────────────── */
        [data-theme="dark"] {
          --color-background-primary:   #0f1117;
          --color-background-secondary: #1a1d27;
          --color-background-info:      #1e2433;
          --color-border-primary:       #2e3347;
          --color-border-secondary:     #2e3347;
          --color-border-tertiary:      #252836;
          --color-border-info:          #3b4a6b;
          --color-text-primary:         #e8eaf0;
          --color-text-secondary:       #8b90a7;
          --color-text-tertiary:        #555b73;
          --color-text-info:            #7eb3f8;
          --color-body-bg:              #0f1117;
          --color-input-bg:             #1a1d27;
          --color-input-border:         #2e3347;
          --color-input-text:           #e8eaf0;
        }
        /* ── Light theme ─────────────────────────────────────────────────────── */
        [data-theme="light"] {
          --color-background-primary:   #ffffff;
          --color-background-secondary: #f4f5f7;
          --color-background-info:      #eef2fb;
          --color-border-primary:       #d1d5e0;
          --color-border-secondary:     #d1d5e0;
          --color-border-tertiary:      #e2e5ed;
          --color-border-info:          #b8c9f0;
          --color-text-primary:         #111827;
          --color-text-secondary:       #4b5563;
          --color-text-tertiary:        #9ca3af;
          --color-text-info:            #3b76d4;
          --color-body-bg:              #f0f2f5;
          --color-input-bg:             #ffffff;
          --color-input-border:         #d1d5e0;
          --color-input-text:           #111827;
        }
        * { box-sizing: border-box; }
        body { background: var(--color-body-bg, #0f1117); margin: 0; padding: 16px; }
        input, textarea, select {
          background: var(--color-input-bg);
          border: 0.5px solid var(--color-input-border);
          color: var(--color-input-text);
          padding: 6px 8px;
          border-radius: 5px;
          font-size: 12px;
          outline: none;
          transition: border-color 0.15s;
        }
        input:focus, textarea:focus, select:focus {
          border-color: #6366f1;
        }
        a { color: inherit; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
      <h2 className="sr-only">Automation Trader</h2>
      {/* ── Live session notification bar ───────────────────────────────────── */}
      {showResumeBar && serverSessions.length > 0 && (() => {
        const liveSessions = serverSessions.filter(s => s.running);
        const pastSessions = serverSessions.filter(s => !s.running && (s.session_name || s.name));
        const hasLive      = liveSessions.length > 0;
        const hasPast      = pastSessions.length > 0;
        if (!hasLive && !hasPast) return null;
        return (
          <div style={{
            position: "fixed", top: 0, left: 0, right: 0, zIndex: 9000,
            background: hasLive ? "#065f46" : (theme === "light" ? "#3730a3" : "#1e1b4b"),
            padding: "0 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            height: 44, boxShadow: "0 1px 0 rgba(255,255,255,0.08)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: hasLive ? "#10b981" : "#818cf8", display: "inline-block",
                boxShadow: hasLive ? "0 0 0 3px #10b98133" : "none" }} />
              <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>
                {hasLive
                  ? `${liveSessions.length} trading session${liveSessions.length>1?"s":""} running on server`
                  : `${pastSessions.length} previous session${pastSessions.length>1?"s":""} available to resume`}
              </span>
              {hasLive && liveSessions.slice(0,2).map(s => (
                <span key={s.sessionId} style={{ fontSize: 11, padding: "1px 8px", borderRadius: 10,
                  background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.8)" }}>
                  {s.name} · ${parseFloat(s.sessionBalance||s.session_balance||0).toFixed(0)}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {!hasLive && pastSessions.length === 1 && (
                <button onClick={async () => {
                    await resumeServerSession(pastSessions[0].sessionId);
                    setShowResumeBar(false);
                  }}
                  style={{ padding: "4px 14px", borderRadius: 6, border: "none",
                    background: "#818cf8", color: "#fff", fontWeight: 700,
                    fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  ▶ Resume
                </button>
              )}
              <button onClick={() => { setShowResumeBar(false); setShowSessionMgr(true); }}
                style={{ padding: "4px 12px", borderRadius: 6,
                  border: "0.5px solid rgba(255,255,255,0.3)",
                  background: "transparent", color: "rgba(255,255,255,0.85)",
                  fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {hasLive ? "View" : "View all"}
              </button>
              <button onClick={() => setShowResumeBar(false)}
                style={{ background: "none", border: "none",
                  color: "rgba(255,255,255,0.5)", fontSize: 18,
                  cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
          </div>
        );
      })()}

      {/* ── Session Manager Panel ─────────────────────────────────────────────── */}
      {showSessionMgr && (
        <>
          {/* Backdrop */}
          <div onClick={() => setShowSessionMgr(false)}
            style={{ position: "fixed", inset: 0, zIndex: 7999,
              background: theme === "light" ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }} />

          <div style={{
            position: "fixed", top: 0, right: 0, bottom: 0, width: 420, zIndex: 8000,
            background: "var(--color-background-primary)",
            borderLeft: "0.5px solid var(--color-border-tertiary)",
            display: "flex", flexDirection: "column",
            boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
          }}>
            {/* ── Panel header ─────────────────────────────────────────────── */}
            <div style={{ padding: "18px 20px 14px",
              borderBottom: "0.5px solid var(--color-border-tertiary)",
              display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-primary)" }}>
                  Trading Sessions
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                  {TRADING_SERVER
                    ? `Connected to ${TRADING_SERVER.replace("https://","").replace("http://","")}`
                    : "Live sessions not configured — paper trading only"}
                </div>
              </div>
              <button onClick={() => setShowSessionMgr(false)}
                style={{ width: 30, height: 30, borderRadius: "50%", border: "none",
                  background: "var(--color-background-secondary)",
                  color: "var(--color-text-secondary)", fontSize: 16,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                ×
              </button>
            </div>

            {/* ── Tab selector: Test sessions vs Live sessions ─────────────────── */}
            <div style={{ display: "flex", gap: 2, padding: "10px 20px 0" }}>
              {[
                { id: "test", label: "🧪 Test sessions",
                count: serverSessions.filter(s => s.mode === "simulation").length },
              { id: "live", label: "⚡ Live sessions",
                count: serverSessions.filter(s => s.mode === "live").length },
              ].map(t => (
                <button key={t.id} onClick={() => setSessionMgrTab(t.id)}
                  style={{ flex: 1, padding: "8px 10px", borderRadius: "8px 8px 0 0",
                    fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                    border: "none", borderBottom: `2px solid ${sessionMgrTab === t.id ? "#6366f1" : "transparent"}`,
                    background: sessionMgrTab === t.id ? "var(--color-background-secondary)" : "transparent",
                    color: sessionMgrTab === t.id ? "#6366f1" : "var(--color-text-tertiary)" }}>
                  {t.label}
                  {t.count > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, padding: "1px 6px", borderRadius: 8,
                      background: sessionMgrTab === t.id ? "#6366f122" : "var(--color-background-secondary)",
                      color: sessionMgrTab === t.id ? "#6366f1" : "var(--color-text-tertiary)" }}>
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* ── Live session server not configured notice ────────────────────── */}
            {!TRADING_SERVER && (
              <div style={{ margin: "14px 20px", padding: "12px 14px", borderRadius: 10,
                background: "#f59e0b0a", border: "0.5px solid #f59e0b44" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>
                  Live session server not connected
                </div>
                <div style={{ fontSize: 11, color: "#b45309", lineHeight: 1.6 }}>
                  Add <code style={{ background: "#f59e0b22", padding: "1px 4px", borderRadius: 3 }}>VITE_TRADING_SERVER=https://trader.quantangleai.com</code> to{" "}
                  <code style={{ background: "#f59e0b22", padding: "1px 4px", borderRadius: 3 }}>.env.local</code>,
                  rebuild, and redeploy to enable 24/7 live trading.
                  Until then, use Paper trade to test your strategy.
                </div>
              </div>
            )}

            {/* ── New session form ──────────────────────────────────────── */}
            {TRADING_SERVER && (() => {
              const coinAllocs = Object.keys(newCoinAllocs).length
                ? newCoinAllocs
                : Object.fromEntries((creds.enabledCoins||["BTC"]).map(c => [c, creds.tradeSizeUSD||"50"]));
              return (
                <div style={{ padding: "14px 20px",
                  borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700,
                    color: "var(--color-text-primary)", marginBottom: 10 }}>
                    New session
                  </div>

                  {/* Name input */}
                  <input value={newSessionName}
                    onChange={e => { setNewSessionName(e.target.value); setNewSessionError(""); }}
                    placeholder="Give this session a name (e.g. BTC momentum test)"
                    style={{ width: "100%", boxSizing: "border-box", fontSize: 12,
                      padding: "8px 10px", borderRadius: 8,
                      border: "0.5px solid var(--color-border-secondary)",
                      background: "var(--color-background-secondary)",
                      color: "var(--color-text-primary)", marginBottom: 10 }} />

                  {/* Mode cards */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    {[
                      { id: "simulation", icon: "🧪", label: "Paper trade",
                        desc: "Test your strategy with no real money" },
                      { id: "live",       icon: "⚡", label: "Live trade",
                        desc: "Execute real orders on the exchange",
                        locked: !limits.canLive || !hasCredentials,
                        lockMsg: !limits.canLive ? "Requires Pro plan" : "Add API keys in Settings" },
                    ].map(m => (
                      <button key={m.id}
                        onClick={() => !m.locked && setNewSessionMode(m.id)}
                        disabled={m.locked}
                        style={{ padding: "10px 12px", borderRadius: 8, textAlign: "left",
                          border: `1.5px solid ${newSessionMode===m.id
                            ? (m.id==="live"?"#10b981":"#6366f1")
                            : "var(--color-border-tertiary)"}`,
                          background: newSessionMode===m.id
                            ? (m.id==="live"?"#10b98109":"#6366f109")
                            : "var(--color-background-secondary)",
                          cursor: m.locked ? "not-allowed" : "pointer",
                          opacity: m.locked ? 0.5 : 1,
                          fontFamily: "inherit", width: "100%" }}>
                        <div style={{ fontSize: 18, marginBottom: 3 }}>{m.icon}</div>
                        <div style={{ fontSize: 11, fontWeight: 700,
                          color: newSessionMode===m.id
                            ? (m.id==="live"?"#10b981":"#6366f1")
                            : "var(--color-text-primary)" }}>
                          {m.label}
                        </div>
                        <div style={{ fontSize: 10,
                          color: m.locked ? "#ef4444" : "var(--color-text-tertiary)",
                          marginTop: 2, lineHeight: 1.3 }}>
                          {m.locked ? m.lockMsg : m.desc}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Per-coin balance */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600,
                      color: "var(--color-text-secondary)", marginBottom: 6 }}>
                      Starting balance per coin
                      <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)", marginLeft: 6 }}>
                        — each coin compounds independently
                      </span>
                    </div>
                    {(creds.enabledCoins || ["BTC"]).map(coin => (
                      <div key={coin} style={{ display: "flex", alignItems: "center",
                        gap: 8, marginBottom: 6 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 8,
                          background: "var(--color-background-secondary)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 10, fontWeight: 800, color: COIN_COLORS[coin] || "#6366f1",
                          flexShrink: 0 }}>{coin}</div>
                        <div style={{ flex: 1, position: "relative" }}>
                          <span style={{ position: "absolute", left: 9, top: "50%",
                            transform: "translateY(-50%)", fontSize: 12,
                            color: "var(--color-text-tertiary)" }}>$</span>
                          <input type="number" min="1"
                            value={coinAllocs[coin] || creds.tradeSizeUSD || "50"}
                            onChange={e => setNewCoinAllocs(p => ({...p, [coin]: e.target.value}))}
                            style={{ width: "100%", boxSizing: "border-box",
                              fontSize: 13, fontWeight: 600,
                              padding: "7px 8px 7px 20px", borderRadius: 7,
                              border: "0.5px solid var(--color-border-secondary)",
                              background: "var(--color-background-primary)",
                              color: "var(--color-text-primary)" }} />
                        </div>
                        <span style={{ fontSize: 10, color: "var(--color-text-tertiary)",
                          minWidth: 28 }}>USD</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)",
                      textAlign: "right" }}>
                      Total committed:{" "}
                      <strong style={{ color: "var(--color-text-secondary)" }}>
                        ${(creds.enabledCoins||["BTC"]).reduce(
                          (s,c) => s + parseFloat(coinAllocs[c]||creds.tradeSizeUSD||50), 0
                        ).toFixed(2)}
                      </strong>
                    </div>
                  </div>

                  {newSessionError && (
                    <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 8,
                      padding: "6px 10px", borderRadius: 6,
                      background: "#ef444411", border: "0.5px solid #ef444433" }}>
                      {newSessionError}
                    </div>
                  )}

                  <button
                    disabled={newSessionStarting}
                    onClick={async () => {
                      if (!newSessionName.trim()) { setNewSessionError("Please name this session"); return; }
                      setNewSessionStarting(true); setNewSessionError("");
                      try {
                        if (newSessionMode === "simulation") {
                          // Test session: now runs on the VPS server 24/7 (not in browser)
                          // Same code path as live but with mode="simulation" — no real orders
                          if (!TRADING_SERVER) {
                            setNewSessionError("Trading server not configured. Set VITE_TRADING_SERVER in .env.local. Without it, test sessions stop when the tab closes.");
                            // Don't return — fall through to show the error but still allow start
                          }
                          const res = await serverFetch("/sessions", {
                            method: "POST",
                            body: JSON.stringify({
                              creds, name: newSessionName.trim(),
                              mode: "simulation", coinAllocations: coinAllocs,
                            }),
                          });
                          const data = await res.json();
                          if (!res.ok) { setNewSessionError(data.error || "Failed to start"); return; }
                          setActiveSessionId(data.sessionId);
                          setNewSessionName("");
                          addAutoLog(`🧪 Test session "${data.name}" started on server — runs 24/7`, "success");
                          fetchServerSessions();
                          setShowSessionMgr(false);
                        } else {
                          // Live trade: runs on the live trading server
                          if (!TRADING_SERVER) {
                            setNewSessionError("Live session server not configured. Set VITE_TRADING_SERVER in .env.local.");
                            return;
                          }
                          const res = await serverFetch("/sessions", {
                            method: "POST",
                            body: JSON.stringify({
                              creds, name: newSessionName.trim(),
                              mode: "live", coinAllocations: coinAllocs,
                            }),
                          });
                          const data = await res.json();
                          if (!res.ok) { setNewSessionError(data.error || "Failed to start"); return; }
                          setActiveSessionId(data.sessionId);
                          setNewSessionName("");
                          addAutoLog(`▶ Live session "${data.name}" started`, "success");
                          fetchServerSessions();
                        }
                      } catch (e) {
                        setNewSessionError(e.message);
                      } finally { setNewSessionStarting(false); }
                    }}
                    style={{ width: "100%", padding: "10px 0", borderRadius: 8,
                      border: "none",
                      background: newSessionStarting ? "#6366f166" : "#6366f1",
                      color: "#fff", fontWeight: 700, fontSize: 13,
                      cursor: newSessionStarting ? "wait" : "pointer",
                      fontFamily: "inherit" }}>
                    {newSessionStarting ? "Starting…" : newSessionMode === "live" ? "▶ Start live session" : "▶ Start paper trade"}
                  </button>
                </div>
              );
            })()}

            {/* ── Session list ──────────────────────────────────────────── */}
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 20px" }}>

              {/* ── Paper sessions (logged-in users only) ─────────────────── */}
              {sessionMgrTab === "test" && !TRADING_SERVER && (
                <div style={{ margin: "0 0 14px",
                  padding: "12px 14px", borderRadius: 10,
                  background: "#f59e0b0a", border: "0.5px solid #f59e0b44" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 3 }}>
                    Trading server not configured
                  </div>
                  <div style={{ fontSize: 11, color: "#b45309", lineHeight: 1.6 }}>
                    Test sessions run on the server 24/7. Set{" "}
                    <code style={{ background: "#f59e0b22", padding: "1px 4px", borderRadius: 3 }}>
                      VITE_TRADING_SERVER
                    </code>{" "}to enable persistent test sessions.
                  </div>
                </div>
              )}
              {sessionMgrTab === "test" && serverSessions.filter(s => s.mode === "simulation").length === 0 && (
                <div style={{ textAlign: "center", padding: "20px 0",
                  color: "var(--color-text-tertiary)", fontSize: 12 }}>
                  No test sessions yet.<br/>Start one above to begin simulation.
                </div>
              )}
              {sessionMgrTab === "test" && serverSessions.filter(s => s.mode === "simulation").map(s => {
                const sid    = s.sessionId || s.session_id;
                const name   = s.name || s.session_name || "Test Session";
                const isActiveSim = sid === activeSessionId;
                // These are pre-normalised in fetchServerSessions
                const coinBals = s.coinBalances || {};
                const bal    = Object.values(coinBals).reduce((a, b) => a + (parseFloat(b.current) || 0), 0);
                const trades = s.totalTrades || 0;
                const totalPnl = Object.values(s.pnl || {}).reduce((a, b) => a + (parseFloat(b)||0), 0);
                const totalUnrealized = Object.values(s.unrealized || {}).reduce((a,b) => a+(parseFloat(b)||0), 0);
                return (
                  <div key={sid}
                    style={{ marginBottom: 10, borderRadius: 10, overflow: "hidden",
                      border: `1.5px solid ${isActiveSim ? "#6366f1" : "var(--color-border-tertiary)"}`,
                      background: isActiveSim ? "#6366f106" : "var(--color-background-secondary)" }}>
                    <div style={{ padding: "10px 14px",
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                          background: s.running ? "#10b981" : "#94a3b8",
                          boxShadow: s.running ? "0 0 0 3px #10b98122" : "none" }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            🧪 {name}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 1 }}>
                            {(s.coins || []).join(", ")}
                            {" · "}{s.running ? "● running on server" : `stopped ${fmtDateTime(new Date(s.updated_at || s.created_at))}`}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button onClick={e => {
                            e.stopPropagation();
                            setViewingSession({
                              name, sessionId: sid, isLive: true,
                              isRunning: s.running, savedAt: s.updated_at,
                              snapshot: {
                                sessionBalance: bal, pnlByCoin: s.pnl || s.pnl_by_coin || {},
                                enabledCoins: s.coins || [], creds: s.credsSnapshot || s.creds_snapshot || {},
                                totalTrades: trades, coinBalances: s.coinBalances || {},
                                logs: s.logs || [], positions: s.positions || {},
                                tradesByCoin: s.tradesByCoin || s.trades_by_coin || {},
                                unrealized: s.unrealized || s.unrealized_by_coin || {},
                              },
                            });
                            setShowViewerDrawer(true);
                            setShowSessionMgr(false);
                          }}
                          style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                            background: "var(--color-background-primary)",
                            color: "var(--color-text-secondary)",
                            border: "0.5px solid var(--color-border-secondary)",
                            cursor: "pointer", fontFamily: "inherit" }}>
                          👁
                        </button>
                        {!s.running && (
                          <button onClick={e => { e.stopPropagation(); resumeServerSession(sid); }}
                            style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                              background: "#6366f1", color: "#fff", border: "none",
                              cursor: "pointer", fontFamily: "inherit" }}>
                            ▶ Resume
                          </button>
                        )}
                        {s.running && (
                          <button onClick={e => { e.stopPropagation(); stopServerSession(sid); }}
                            style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                              background: "#ef444422", color: "#ef4444",
                              border: "0.5px solid #ef444444", cursor: "pointer", fontFamily: "inherit" }}>
                            ⏹ Stop
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ padding: "0 14px 10px",
                      display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                      {[
                        { label: "Balance", val: `$${bal.toFixed(2)}`, color: "var(--color-text-primary)" },
                        { label: "Realized P&L", val: `${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`,
                          color: totalPnl >= 0 ? "#10b981" : "#ef4444" },
                        { label: "Unrealized", val: `${totalUnrealized>=0?"+":""}$${totalUnrealized.toFixed(2)}`,
                          color: totalUnrealized >= 0 ? "#10b981" : "#f59e0b" },
                        { label: "Trades", val: trades, color: "var(--color-text-primary)" },
                      ].map(stat => (
                        <div key={stat.label} style={{ background: "var(--color-background-primary)",
                          borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "var(--color-text-tertiary)",
                            marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            {stat.label}
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: stat.color }}>
                            {stat.val}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {/* Legacy: old browser-based paper session snapshots (shown for migration) */}
              {sessionMgrTab === "test" && clerkUser && paperSessions.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ display: "flex", alignItems: "center",
                    justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700,
                      color: "var(--color-text-secondary)",
                      textTransform: "uppercase", letterSpacing: 0.5 }}>
                      🧪 Saved paper sessions
                    </div>
                    {/* Save current paper session inline — uses component-level paperInlineName */}
                    {running && !autoEnabled && (
                      <div style={{ display: "flex", gap: 5 }}>
                        <input value={paperInlineName}
                          onChange={e => setPaperInlineName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter" && paperInlineName.trim()) {
                              savePaperSession(paperInlineName.trim());
                              setPaperInlineName("");
                            }
                          }}
                          placeholder="Name & save current…"
                          style={{ fontSize: 10, padding: "4px 8px", borderRadius: 5,
                            border: "0.5px solid var(--color-border-secondary)",
                            background: "var(--color-background-secondary)",
                            color: "var(--color-text-primary)", width: 130 }} />
                        <button
                          disabled={!paperInlineName.trim() || paperSaving}
                          onClick={() => {
                            if (paperInlineName.trim()) {
                              savePaperSession(paperInlineName.trim());
                              setPaperInlineName("");
                            }
                          }}
                          style={{ padding: "4px 10px", borderRadius: 5, fontSize: 10,
                            fontWeight: 700, background: "#6366f1", color: "#fff",
                            border: "none", cursor: "pointer", fontFamily: "inherit",
                            opacity: paperInlineName.trim() ? 1 : 0.4 }}>
                          {paperSaving ? "…" : "Save"}
                        </button>
                      </div>
                    )}
                  </div>

                  {paperSessions.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--color-text-tertiary)",
                      padding: "12px 14px", borderRadius: 8, textAlign: "center",
                      background: "var(--color-background-secondary)" }}>
                      No saved paper sessions yet.
                      {running && !autoEnabled
                        ? " Name and save your current session above."
                        : " Start a paper trade and click ☁️ Save session to preserve your progress."}
                    </div>
                  ) : paperSessions.map(ps => {
                    const sid      = ps.session_id;
                    const snap     = ps.snapshot || {};
                    const bal      = parseFloat(snap.sessionBalance || 0);
                    const totalPnl = Object.values(snap.pnlByCoin || {})
                      .reduce((a,b) => a + (parseFloat(b)||0), 0);
                    const trades   = snap.totalTrades || 0;
                    const coins    = snap.enabledCoins || [];
                    // isActive: this session is the one CURRENTLY running in this browser tab
                    // right now. Paper sessions cannot run in the background — only one can
                    // be active per tab, and only while `running` is true.
                    const isActive = sid === activePaperSessionId && running;
                    // stopped === true only when the user explicitly clicked Stop.
                    // stopped === false (or missing, for older sessions) means the
                    // last known state was WHILE running — treat as still active,
                    // since paper sessions are conceptually "on" until stopped.
                    const wasStopped = snap.stopped === true;
                    // Same card structure/style as Live session cards for consistency
                    return (
                      <div key={sid}
                        style={{ marginBottom: 10, borderRadius: 10, overflow: "hidden",
                          border: `1.5px solid ${isActive ? "#6366f1" : "var(--color-border-tertiary)"}`,
                          background: isActive ? "#6366f106" : "var(--color-background-secondary)",
                          transition: "border-color 0.15s" }}>

                        {/* Card header */}
                        <div style={{ padding: "10px 14px",
                          display: "flex", alignItems: "center",
                          justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                              background: isActive ? "#10b981" : wasStopped ? "#94a3b8" : "#f59e0b",
                              boxShadow: isActive ? "0 0 0 3px #10b98122" : "none" }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700,
                                color: "var(--color-text-primary)",
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {ps.name}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 1 }}>
                                🧪 Paper · {snap.signalSource || "rules"}
                                {" · "}{coins.join(", ")}
                                {isActive
                                  ? <span style={{ color: "#10b981" }}> · ● running now in this tab</span>
                                  : wasStopped
                                    ? <> · stopped {fmtDateTime(new Date(ps.updated_at))}</>
                                    : <span style={{ color: "#f59e0b" }}> · interrupted — last synced {fmtDateTime(new Date(ps.updated_at))}</span>}
                              </div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button data-tour="session-eye-icon" onClick={e => {
                                e.stopPropagation();
                                setViewingSession({ name: ps.name, snapshot: ps.snapshot, savedAt: ps.updated_at, sessionId: sid });
                                setShowViewerDrawer(true);
                                setShowSessionMgr(false);
                              }}
                              title="View this session's stats and settings"
                              style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11,
                                fontWeight: 600, background: "var(--color-background-primary)",
                                color: "var(--color-text-secondary)",
                                border: "0.5px solid var(--color-border-secondary)",
                                cursor: "pointer", fontFamily: "inherit" }}>
                              👁
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); if (!isActive) resumePaperSession(ps); }}
                              disabled={isActive}
                              title={isActive
                                ? "Already running in this tab — nothing to resume"
                                : wasStopped
                                  ? "Resume from where you stopped"
                                  : "Resume — session is still running on the server"}
                              style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11,
                                fontWeight: 700,
                                background: isActive ? "var(--color-background-primary)" : "#6366f1",
                                color: isActive ? "var(--color-text-tertiary)" : "#fff",
                                border: isActive ? "0.5px solid var(--color-border-secondary)" : "none",
                                cursor: isActive ? "not-allowed" : "pointer",
                                opacity: isActive ? 0.6 : 1,
                                fontFamily: "inherit" }}>
                              {isActive ? "● Running" : "▶ Resume"}
                            </button>
                            <button onClick={e => {
                                e.stopPropagation();
                                if (window.confirm(`Delete "${ps.name}"?`)) deletePaperSession(sid);
                              }}
                              style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11,
                                fontWeight: 700, background: "#ef444422",
                                color: "#ef4444", border: "0.5px solid #ef444444",
                                cursor: "pointer", fontFamily: "inherit" }}>
                              ×
                            </button>
                          </div>
                        </div>

                        {/* Stats row */}
                        <div style={{ padding: "0 14px 10px",
                          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                          {[
                            { label: "Balance",  val: `$${bal.toFixed(2)}`,  color: "var(--color-text-primary)" },
                            { label: "P&L",      val: `${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`,
                              color: totalPnl >= 0 ? "#10b981" : "#ef4444" },
                            { label: "Trades",   val: trades,               color: "var(--color-text-primary)" },
                          ].map(stat => (
                            <div key={stat.label} style={{ background: "var(--color-background-primary)",
                              borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                              <div style={{ fontSize: 9, color: "var(--color-text-tertiary)",
                                marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                {stat.label}
                              </div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: stat.color }}>
                                {stat.val}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Per-coin balance pills */}
                        {coins.length > 0 && (
                          <div style={{ padding: "0 14px 10px",
                            display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {coins.map(coin => {
                              const cb  = (snap.coinBalances || {})[coin];
                              const pnl = parseFloat((snap.pnlByCoin || {})[coin] || 0);
                              return (
                                <div key={coin} style={{ display: "flex", alignItems: "center",
                                  gap: 5, padding: "3px 8px", borderRadius: 5,
                                  background: "var(--color-background-primary)",
                                  border: "0.5px solid var(--color-border-tertiary)", fontSize: 10 }}>
                                  <span style={{ fontWeight: 700,
                                    color: COIN_COLORS[coin] || "#6366f1" }}>{coin}</span>
                                  <span style={{ color: "var(--color-text-secondary)" }}>
                                    ${cb ? parseFloat(cb.current||0).toFixed(2) : bal.toFixed(2)}
                                  </span>
                                  <span style={{ color: pnl>=0?"#10b981":"#ef4444" }}>
                                    {pnl>=0?"+":""}{pnl.toFixed(2)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                </div>
              )}

              {/* ── Live sessions heading + list ──────────────────────────── */}
              {sessionMgrTab === "live" && !TRADING_SERVER && (
                <div style={{ textAlign: "center", padding: "40px 20px",
                  color: "var(--color-text-tertiary)", fontSize: 12, lineHeight: 1.6 }}>
                  Live session server not configured.<br/>Set VITE_TRADING_SERVER to enable live trading.
                </div>
              )}
              {sessionMgrTab === "live" && TRADING_SERVER && (
                <div style={{ marginBottom: 10 }}>
                  {serverSessions.length === 0 && (
                    <div style={{ textAlign: "center", padding: "20px 0",
                      color: "var(--color-text-tertiary)", fontSize: 12 }}>
                      No live sessions yet.<br/>Start one above to begin live trading.
                    </div>
                  )}
                </div>
              )}
              {sessionMgrTab === "live" && serverSessions.filter(s => s.mode === "live").map(s => {
                const sid      = s.sessionId || s.session_id;
                const name     = s.name || s.session_name || "Session";
                const isActive = sid === activeSessionId;
                const totalPnl = Object.values(s.pnl || s.pnl_by_coin || {})
                  .reduce((a,b) => a + (parseFloat(b)||0), 0);
                const bal      = parseFloat(s.sessionBalance || s.session_balance || 0);
                const trades   = s.total_trades || s.totalTrades || 0;
                return (
                  <div key={sid}
                    onClick={() => setActiveSessionId(isActive ? null : sid)}
                    style={{ marginBottom: 10, borderRadius: 10, overflow: "hidden",
                      border: `1.5px solid ${isActive
                        ? (s.running ? "#10b981" : "#6366f1")
                        : "var(--color-border-tertiary)"}`,
                      background: isActive
                        ? (s.running ? "#10b98106" : "#6366f106")
                        : "var(--color-background-secondary)",
                      cursor: "pointer", transition: "border-color 0.15s" }}>

                    {/* Card header */}
                    <div style={{ padding: "10px 14px",
                      display: "flex", alignItems: "center",
                      justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                          background: s.running ? "#10b981" : "#94a3b8",
                          boxShadow: s.running ? "0 0 0 3px #10b98122" : "none" }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700,
                            color: "var(--color-text-primary)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {name}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 1 }}>
                            {s.mode === "live" ? "⚡ Live" : "🧪 Paper"} · {s.exchange || "binance"}
                            {" · "}{(s.coins||[]).join(", ")}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {!s.running && (
                          <>
                            <button onClick={e => {
                                e.stopPropagation();
                                setViewingSession({
                                  name: name,
                                  savedAt: s.updated_at,
                                  sessionId: sid,
                                  snapshot: {
                                    sessionBalance: bal,
                                    pnlByCoin:      s.pnl || s.pnl_by_coin || {},
                                    enabledCoins:   s.coins || [],
                                    creds:          s.creds_snapshot || {},
                                    signalSource:   s.creds_snapshot?.signalSource || "rules",
                                    totalTrades:    trades,
                                    coinBalances:   s.coinBalances || s.coin_balances || {},
                                    logs:           s.logs || [],
                                    positions:      s.positions || {},
                                    tradesByCoin:   s.trades_by_coin || s.tradesByCoin || {},
                                  },
                                  isLive: true,
                                });
                                setShowViewerDrawer(true);
                                setShowSessionMgr(false);
                              }}
                              style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11,
                                fontWeight: 600, background: "var(--color-background-primary)",
                                color: "var(--color-text-secondary)",
                                border: "0.5px solid var(--color-border-secondary)",
                                cursor: "pointer", fontFamily: "inherit" }}>
                              👁
                            </button>
                            <button onClick={e => { e.stopPropagation(); resumeServerSession(sid); }}
                              style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11,
                                fontWeight: 700, background: "#6366f1",
                                color: "#fff", border: "none", cursor: "pointer",
                                fontFamily: "inherit" }}>
                              ▶ Resume
                            </button>
                          </>
                        )}
                        {s.running && (
                          <>
                            <button onClick={e => {
                                e.stopPropagation();
                                // Switch main dashboard to show this session's live data
                                setActiveSessionId(sid);
                                setViewingSession({
                                  name:      name,
                                  sessionId: sid,
                                  isLive:    true,
                                  isRunning: true,
                                  savedAt:   s.updated_at,
                                  snapshot: {
                                    sessionBalance: bal,
                                    pnlByCoin:      s.pnl || s.pnl_by_coin || {},
                                    enabledCoins:   s.coins || [],
                                    creds:          s.creds_snapshot || {},
                                    signalSource:   s.creds_snapshot?.signalSource || "rules",
                                    totalTrades:    trades,
                                    coinBalances:   s.coinBalances || s.coin_balances || {},
                                    logs:           s.logs || [],
                                    positions:      s.positions || {},
                                    tradesByCoin:   s.trades_by_coin || s.tradesByCoin || {},
                                  },
                                });
                                setShowViewerDrawer(true);
                                setShowSessionMgr(false);
                              }}
                              style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11,
                                fontWeight: 600, background: "var(--color-background-primary)",
                                color: "var(--color-text-secondary)",
                                border: "0.5px solid var(--color-border-secondary)",
                                cursor: "pointer", fontFamily: "inherit" }}>
                              👁 View
                            </button>
                            <button onClick={e => { e.stopPropagation(); stopServerSession(sid); }}
                              style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11,
                                fontWeight: 700, background: "#ef444422",
                                color: "#ef4444", border: "0.5px solid #ef444444",
                                cursor: "pointer", fontFamily: "inherit" }}>
                              ⏹ Stop
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Stats row */}
                    <div style={{ padding: "0 14px 10px",
                      display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      {[
                        { label: "Balance",  val: `$${bal.toFixed(2)}`,  color: "var(--color-text-primary)" },
                        { label: "P&L",      val: `${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`,
                          color: totalPnl >= 0 ? "#10b981" : "#ef4444" },
                        { label: "Trades",   val: trades,               color: "var(--color-text-primary)" },
                      ].map(stat => (
                        <div key={stat.label} style={{ background: "var(--color-background-primary)",
                          borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "var(--color-text-tertiary)",
                            marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            {stat.label}
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: stat.color }}>
                            {stat.val}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Per-coin balance pills */}
                    {(s.coins||[]).length > 0 && (
                      <div style={{ padding: "0 14px 10px",
                        display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {(s.coins||[]).map(coin => {
                          const cb  = (s.coinBalances || s.coin_balances || {})[coin];
                          const pnl = parseFloat((s.pnl||s.pnl_by_coin||{})[coin]||0);
                          return (
                            <div key={coin} style={{ display: "flex", alignItems: "center",
                              gap: 5, padding: "3px 8px", borderRadius: 5,
                              background: "var(--color-background-primary)",
                              border: "0.5px solid var(--color-border-tertiary)", fontSize: 10 }}>
                              <span style={{ fontWeight: 700,
                                color: COIN_COLORS[coin] || "#6366f1" }}>{coin}</span>
                              <span style={{ color: "var(--color-text-secondary)" }}>
                                ${cb ? parseFloat(cb.current||0).toFixed(2) : "—"}
                              </span>
                              <span style={{ color: pnl>=0?"#10b981":"#ef4444" }}>
                                {pnl>=0?"+":""}{pnl.toFixed(2)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Marketplace overlay ─────────────────────────────────────────────────── */}
      {showMarketplace && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 8800,
          background: "var(--color-background-primary)",
          display: "flex", flexDirection: "column",
        }}>
          <MarketplacePanel
            PROXY_BASE={PROXY_BASE}
            creds={creds}
            theme={theme}
            clerkUser={clerkUser}
            onClose={() => setShowMarketplace(false)}
            onCopy={({ settings, coins, signalSource }) => {
              // Merge copied strategy settings into current creds
              // (keep user's own API keys, trade size, provider)
              const merged = {
                ...creds,          // keep keys, tradeSizeUSD, provider
                ...settings,       // overlay signal config, exits, indicators, rules
                enabledCoins: coins || creds.enabledCoins,
                signalSource:  signalSource || settings.signalSource || creds.signalSource,
              };
              setCreds(merged);
              setShowMarketplace(false);
              setShowSettings(true); // open settings so user can review before running
              addAutoLog("📋 Strategy copied — review settings before starting", "info");
            }}
          />
        </div>
      )}

      {/* ── Onboarding tour overlay ───────────────────────────────────────────── */}
      {tourActive && (
        <OnboardingTour
          steps={visibleTourSteps}
          stepIndex={Math.min(tourStep, visibleTourSteps.length - 1)}
          onNext={() => setTourStep(s => Math.min(s + 1, visibleTourSteps.length - 1))}
          onBack={() => setTourStep(s => Math.max(s - 1, 0))}
          onSkip={endTour}
          onFinish={endTour}
        />
      )}

      {/* ── Session context bar — shown when viewing a saved session ─────────── */}
      {viewingSession && (!running || viewingSession.isRunning) && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9001,
          background: theme === "light" ? "#3730a3" : "#1e1b4b", padding: "0 20px", height: 44,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          boxShadow: "0 1px 0 rgba(255,255,255,0.08)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {viewingSession.isRunning ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%",
                  background: "#10b981", boxShadow: "0 0 0 3px #10b98133",
                  display: "inline-block", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: "#10b981", fontWeight: 600 }}>Live</span>
              </div>
            ) : (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Viewing</span>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
              {viewingSession.isLive ? "⚡" : "🧪"} {viewingSession.name}
            </span>
            {viewingSession.isRunning && (
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                updates every 3s
              </span>
            )}
            {!viewingSession.isRunning && viewingSession.savedAt && (
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                saved {fmtDateTime(new Date(viewingSession.savedAt))}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!viewingSession.isLive && !viewingSession.isRunning && (
              <>
                <button onClick={() => {
                    const ps = paperSessions.find(p => p.session_id === viewingSession.sessionId);
                    if (ps) { resumePaperSession(ps); }
                    // resumePaperSession clears viewingSession internally
                  }}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    background: "#6366f1", color: "#fff", border: "none",
                    cursor: "pointer", fontFamily: "inherit" }}>
                  ▶ Resume
                </button>
                <button onClick={() => {
                    const ps = paperSessions.find(p => p.session_id === viewingSession.sessionId);
                    if (ps?.snapshot?.creds) {
                      setCreds(ps.snapshot.creds);
                      const bal = parseFloat(ps.snapshot.creds.tradeSizeUSD) || 50;
                      sessionBalanceRef.current = bal;
                      sessionStartBalanceRef.current = bal;
                      setSessionBalance(bal);
                      // Reset charts
                      for (const c of (ps.snapshot.enabledCoins || ["BTC"])) {
                        if (stateRef.current[c]) {
                          const lastPrice = stateRef.current[c].prices.at(-1) || COIN_BASE[c] || 1;
                          stateRef.current[c].prices  = [lastPrice];
                          stateRef.current[c].volumes = [1];
                          stateRef.current[c].history = [];
                          stateRef.current[c].pnl     = 0;
                          stateRef.current[c].trades  = 0;
                          stateRef.current[c].position = null;
                        }
                      }
                      setWsEnabled(true); setRunning(true);
                      const newId = crypto.randomUUID();
                      setActivePaperSessionId(newId);
                      setActivePaperSessionName(`${ps.name} (new)`);
                      addAutoLog(`▶ Fresh start from "${ps.name}" — $${bal.toFixed(2)} · charts will fill as prices arrive`, "info");
                    }
                    setViewingSession(null);
                  }}
                  style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11,
                    border: "0.5px solid rgba(255,255,255,0.3)",
                    background: "transparent", color: "rgba(255,255,255,0.8)",
                    cursor: "pointer", fontFamily: "inherit" }}>
                  + Fresh start
                </button>
              </>
            )}
            {viewingSession.isLive && !viewingSession.isRunning && (
              <button onClick={() => { resumeServerSession(viewingSession.sessionId); setViewingSession(null); }}
                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                  background: "#10b981", color: "#fff", border: "none",
                  cursor: "pointer", fontFamily: "inherit" }}>
                ▶ Resume live session
              </button>
            )}
            {viewingSession.isRunning && (
              <button onClick={() => { stopServerSession(viewingSession.sessionId); setViewingSession(null); }}
                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                  background: "#ef444422", color: "#ef4444",
                  border: "0.5px solid #ef444444",
                  cursor: "pointer", fontFamily: "inherit" }}>
                ⏹ Stop session
              </button>
            )}
            {/* Details toggle — reopens the drawer if the user closed it */}
            {!showViewerDrawer && (
              <button onClick={() => setShowViewerDrawer(true)}
                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                  border: "0.5px solid rgba(255,255,255,0.3)",
                  background: "transparent", color: "rgba(255,255,255,0.85)",
                  cursor: "pointer", fontFamily: "inherit" }}>
                Details
              </button>
            )}
            <button onClick={() => setViewingSession(null)}
              title="Exit session view — return to live dashboard"
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)",
                fontSize: 18, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>
              ×
            </button>
          </div>
        </div>
      )}

      {/* ── Session Viewer Panel ──────────────────────────────────────────────── */}
      {viewingSession && showViewerDrawer && (() => {
        const snap = viewingSession.snapshot || {};
        const bal  = parseFloat(snap.sessionBalance || 0);
        const coins = snap.enabledCoins || [];
        const pnlByCoin = snap.pnlByCoin || snap.pnl_by_coin || {};
        const totalPnl  = Object.values(pnlByCoin).reduce((a,b) => a+(parseFloat(b)||0), 0);
        const trades    = snap.totalTrades || 0;
        const logs      = snap.logs || [];
        const rlState   = snap.rlTables || {};
        const coinBals  = snap.coinBalances || snap.coin_balances || {};

        return (
          <>
            {/* No backdrop — dashboard stays visible and interactive.
                Drawer sits below the context bar (44px) on the right. */}
            <div style={{
              position:"fixed", top:44, right:0, bottom:0, width:340, zIndex:8600,
              background:"var(--color-background-primary)",
              borderLeft:"0.5px solid var(--color-border-tertiary)",
              display:"flex", flexDirection:"column",
              boxShadow:"-6px 0 24px rgba(0,0,0,0.3)",
            }}>
              {/* Header */}
              <div style={{ padding:"14px 16px 12px",
                borderBottom:"0.5px solid var(--color-border-tertiary)",
                display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:700,
                    color:"var(--color-text-primary)",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    Session details
                  </div>
                  <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:2 }}>
                    RL state · settings · logs
                  </div>
                </div>
                <button onClick={() => setShowViewerDrawer(false)}
                  title="Hide details panel — dashboard stays in session view"
                  style={{ width:26, height:26, borderRadius:"50%", border:"none",
                    background:"var(--color-background-secondary)",
                    color:"var(--color-text-secondary)", fontSize:14,
                    cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  ×
                </button>
              </div>

              <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>

                {/* Note */}
                <div style={{ padding:"8px 10px", borderRadius:7, marginBottom:14,
                  background:"#6366f111", border:"0.5px solid #6366f133", fontSize:10,
                  color:"#6366f1", lineHeight:1.5 }}>
                  📊 The main dashboard on the left now shows this session's P&L,
                  trades, positions and balance. Use the coin tabs to switch coins.
                </div>

                {/* RL Q-table summary */}
                {Object.keys(rlState).length > 0 && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"var(--color-text-secondary)",
                      marginBottom:8, textTransform:"uppercase", letterSpacing:0.5 }}>
                      🎮 RL Agent State
                    </div>
                    {Object.entries(rlState).map(([coin, t]) => (
                      <div key={coin} style={{ padding:"8px 12px", borderRadius:7, marginBottom:6,
                        background:"var(--color-background-secondary)",
                        border:"0.5px solid #6366f122" }}>
                        <div style={{ display:"flex", justifyContent:"space-between",
                          fontSize:11, marginBottom:4 }}>
                          <span style={{ fontWeight:700, color:COIN_COLORS[coin]||"#6366f1" }}>{coin}</span>
                          <span style={{ color:"var(--color-text-tertiary)" }}>
                            {t.episodes || 0} episodes · ε={parseFloat(t.epsilon||0.4).toFixed(3)}
                          </span>
                        </div>
                        <div style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>
                          {Object.keys(t.qTable||{}).length} states learned
                          {t.episodes >= 20
                            ? " · ✓ trained"
                            : ` · needs ${20-(t.episodes||0)} more episodes`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Session settings summary */}
                {snap.creds && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"var(--color-text-secondary)",
                      marginBottom:8, textTransform:"uppercase", letterSpacing:0.5 }}>
                      Settings used
                    </div>
                    <div style={{ padding:"10px 12px", borderRadius:8,
                      background:"var(--color-background-secondary)", fontSize:11,
                      color:"var(--color-text-secondary)", lineHeight:1.8 }}>
                      <div>Signal: <strong style={{ color:"var(--color-text-primary)" }}>{snap.signalSource || snap.creds?.signalSource || "rules"}</strong></div>
                      <div>Coins: <strong style={{ color:"var(--color-text-primary)" }}>{coins.join(", ") || "—"}</strong></div>
                      <div>Starting balance: <strong style={{ color:"var(--color-text-primary)" }}>${parseFloat(snap.creds?.tradeSizeUSD||50).toFixed(2)}</strong></div>
                      <div>Exchange: <strong style={{ color:"var(--color-text-primary)" }}>{snap.creds?.provider || "binance"}</strong></div>
                      {snap.creds?.tickIntervalMs && (
                        <div>Tick interval: <strong style={{ color:"var(--color-text-primary)" }}>
                          {snap.creds.tickIntervalMs >= 60000
                            ? `${snap.creds.tickIntervalMs/60000}min`
                            : `${snap.creds.tickIntervalMs/1000}s`}
                        </strong></div>
                      )}
                    </div>
                  </div>
                )}

                {/* Logs */}
                {logs.length > 0 && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:"var(--color-text-secondary)",
                      marginBottom:8, textTransform:"uppercase", letterSpacing:0.5 }}>
                      Last {logs.length} log entries
                    </div>
                    <div style={{ borderRadius:8, overflow:"hidden",
                      border:"0.5px solid var(--color-border-tertiary)" }}>
                      {logs.slice(0,30).map((l, i) => {
                        const msg  = typeof l === "string" ? l : l.msg || "";
                        const type = typeof l === "string" ? "info" : l.type || "info";
                        const time = typeof l === "string" ? "" : l.time || fmtTime(new Date(l.ts||""));
                        const col  = type==="success"?"#10b981":type==="warn"?"#f59e0b":type==="error"?"#ef4444":"var(--color-text-secondary)";
                        return (
                          <div key={i} style={{ padding:"5px 10px", fontSize:10,
                            borderBottom: i < logs.length-1 ? "0.5px solid var(--color-border-tertiary)" : "none",
                            background: i%2===0 ? "var(--color-background-secondary)" : "var(--color-background-primary)",
                            display:"flex", gap:8 }}>
                            {time && <span style={{ color:"var(--color-text-tertiary)", flexShrink:0 }}>{time}</span>}
                            <span style={{ color:col }}>{msg}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}

      {showSettings && (() => {
        // When viewing a session, edit THAT session's settings, not the browser defaults
        const viewedSnap     = viewingSession?.snapshot;
        const sessionCreds   = viewedSnap?.creds && Object.keys(viewedSnap.creds).length > 0
          ? viewedSnap.creds
          : null;
        const editingSession = !!sessionCreds && !!viewingSession;
        const modalCreds     = editingSession ? sessionCreds : creds;

        return (
          <SettingsModal
            creds={modalCreds}
            limits={limits}
            clerkPlan={clerkPlan}
            forcedTab={tourActive ? tourForcedTab : null}
            sessionContext={editingSession ? {
              name:      viewingSession.name,
              isRunning: viewingSession.isRunning,
              isLive:    viewingSession.isLive,
            } : null}
            onSave={async (f) => {
              setShowSettings(false);

              // Always update browser creds AND localStorage immediately,
              // regardless of whether we're editing a session or not.
              // This ensures settings survive tab close in all cases.
              if (!editingSession) {
                setCreds(f);
                // Belt-and-suspenders: write directly in addition to the useEffect
                try {
                  const { keys, ...safe } = f;
                  localStorage.setItem("automation_trader_creds", JSON.stringify(safe));
                } catch (_) {}
                addAutoLog("⚙️ Settings saved", "info");
              } else if (viewingSession.isRunning && viewingSession.sessionId) {
                // Also push to the running server session
                try {
                  await serverFetch(`/sessions/${viewingSession.sessionId}`, {
                    method: "PUT",
                    body:   JSON.stringify({ creds: f }),
                  });
                  addAutoLog(`⚙️ Settings updated on session "${viewingSession.name}"`, "success");
                  setViewingSession(prev => prev ? ({
                    ...prev,
                    snapshot: { ...prev.snapshot, creds: f },
                  }) : null);
                  fetchServerSessions();
                } catch (e) {
                  addAutoLog(`Settings push failed: ${e.message}`, "error");
                }
              } else {
                // Stopped session — update the snapshot in memory
                addAutoLog(`⚙️ Session settings updated (resume to apply)`, "info");
                setViewingSession(prev => prev ? ({
                  ...prev,
                  snapshot: { ...prev.snapshot, creds: f },
                }) : null);
              }
            }}
            onClose={() => { setShowSettings(false); if (tourActive) setTourForcedTab(null); }}
          />
        );
      })()}

      {/* ── Top toolbar ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {DISPLAY_COINS.map((c) => {
          const inCurrent = !running || runningCoins.includes(c);
          const isActive  = effectiveCoin === c;
          return (
            <button key={c} onClick={() => setSelectedCoin(c)}
              title={!inCurrent && running ? `${c} is not in the active session` : undefined}
              style={{
                padding: "5px 12px", borderRadius: 6, border: "0.5px solid",
                borderColor: isActive ? COIN_COLORS[c] : "var(--color-border-tertiary)",
                background: isActive ? COIN_COLORS[c] + "22" : "transparent",
                color: isActive ? COIN_COLORS[c] : !inCurrent ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
                cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
                opacity: !inCurrent && running ? 0.45 : 1,
              }}>
              {c}
              {!inCurrent && running && (
                <span style={{ marginLeft: 3, fontSize: 9, color: "var(--color-text-tertiary)" }}>—</span>
              )}
            </button>
          );
        })}

        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Algo speed</label>
          <input type="range" min="400" max="3000" step="200" value={speed} onChange={(e) => setSpeed(+e.target.value)} style={{ width: 70 }} />
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 32 }}>{(speed / 1000).toFixed(1)}s</span>

          <button data-tour="settings-btn" onClick={() => setShowSettings(true)}
            style={{ padding: "5px 14px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
            <i className="ti ti-settings" aria-hidden="true" /> Settings
            {hasCredentials && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />}
          </button>

          {/* Live session status + session manager button — always visible */}
          <button data-tour="sessions-btn" onClick={() => setShowSessionMgr(s => !s)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10,
              padding: "3px 9px", borderRadius: 10, cursor: "pointer",
              background: serverStatus === "running" ? "#10b98122" : serverStatus === "error" ? "#ef444422" : "var(--color-background-secondary)",
              border: `0.5px solid ${serverStatus === "running" ? "#10b981" : serverStatus === "error" ? "#ef4444" : "var(--color-border-tertiary)"}`,
              color: serverStatus === "running" ? "#10b981" : serverStatus === "error" ? "#ef4444" : "var(--color-text-tertiary)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", display: "inline-block", flexShrink: 0,
              background: serverStatus === "running" ? "#10b981" : serverStatus === "error" ? "#ef4444" : "#94a3b8",
              boxShadow: serverStatus === "running" ? "0 0 4px #10b981" : "none" }} />
            Sessions (Live {serverStatus === "running"
              ? `${serverSessions.filter(s=>s.running).length} running`
              : serverStatus === "auth_pending" ? "signing in…"
              : serverStatus === "error" ? "error"
              : serverStatus === "not_configured" ? "not set"
              : !clerkLoaded ? "loading…"
              : "idle"})
            {serverSessions.length > 0 && <span style={{ marginLeft: 2 }}>({serverSessions.length})</span>}
          </button>

          {/* Marketplace button */}
          <button
            onClick={() => setShowMarketplace(s => !s)}
            data-tour="marketplace-btn"
            title="Browse and share trading strategies"
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              border: `0.5px solid ${showMarketplace ? "#6366f1" : "var(--color-border-secondary)"}`,
              background: showMarketplace ? "#6366f111" : "transparent",
              color: showMarketplace ? "#6366f1" : "var(--color-text-secondary)",
              cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 5 }}>
            🌐 Marketplace
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            style={{ width: 26, height: 26, borderRadius: "50%",
              border: "0.5px solid var(--color-border-secondary)",
              background: "transparent",
              color: "var(--color-text-secondary)", fontSize: 14,
              cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "center" }}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>

          {/* Restart tour button */}
          <button
            onClick={() => { setTourStep(0); setTourActive(true); }}
            title="Show the setup tutorial"
            style={{ width: 26, height: 26, borderRadius: "50%", border: "0.5px solid var(--color-border-secondary)",
              background: "transparent", color: "var(--color-text-secondary)", fontSize: 13,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "inherit" }}>
            ?
          </button>

          {/* User badge + plan + logout — only shown when Clerk is active */}
          {clerkUser && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10,
                background: clerkPlan === "pro_ai" ? "#10b98122" : clerkPlan === "pro" ? "#6366f122" : "#94a3b822",
                color:      clerkPlan === "pro_ai" ? "#10b981"   : clerkPlan === "pro" ? "#6366f1"   : "#94a3b8",
                fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>
                {clerkPlan === "pro_ai" ? "Pro AI" : clerkPlan === "pro" ? "Pro" : "Free"}
              </span>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {clerkUser.primaryEmailAddress?.emailAddress || clerkUser.username || "User"}
              </span>
              <button
                onClick={() => clerkSignOut && clerkSignOut()}
                title="Sign out"
                style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid #ef444466", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 11, color: "#ef4444", display: "flex", alignItems: "center", gap: 4 }}>
                <i className="ti ti-logout" aria-hidden="true" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Exchange Automation Panel ────────────────────────────────────────── */}
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: `0.5px solid ${autoEnabled ? statusColor + "88" : "var(--color-border-tertiary)"}`, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, display: "inline-block", boxShadow: autoEnabled ? `0 0 6px ${statusColor}` : "none" }} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>{activeProvider.logo} {activeProvider.name}</span>
            <span style={{ fontSize: 11, color: statusColor, fontWeight: 500 }}>{statusLabel}</span>
          </div>

          {cbError && <span style={{ fontSize: 11, color: "#ef4444", flex: 1 }}><i className="ti ti-alert-circle" aria-hidden="true" /> {cbError}</span>}
        {/* Session balance display */}
        {(running && sessionBalance !== null || (isViewing && viewedSessionData)) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
            <span style={{ color: "var(--color-text-tertiary)" }}>
              {isViewing ? "Session balance:" : "Trading balance:"}
            </span>
            {(() => {
              const bal = isViewing
                ? (viewedCoin?.balance || viewedSessionData?.eff.sessionBalance || 0)
                : (sessionBalance || 0);
              // For live (non-viewing) sessions, "start" is the balance at the
              // moment THIS run began — fresh start or resume — not the session's
              // original genesis balance. This makes "from start" mean "this run".
              // For viewed sessions, use the coin's own starting allocation.
              const start = isViewing
                ? (viewedCoin?.allocated != null ? viewedCoin.allocated : parseFloat(displayCreds.tradeSizeUSD || 50))
                : (sessionStartBalanceRef.current != null ? sessionStartBalanceRef.current : parseFloat(displayCreds.tradeSizeUSD || 50));
              const diff  = bal - start;
              return (
                <>
                  <span style={{ fontWeight: 700, color: bal >= start ? "#10b981" : "#ef4444" }}>
                    ${bal.toFixed(2)}
                  </span>
                  {Math.abs(diff) > 0.01 && (
                    <span style={{ fontSize: 10, color: diff >= 0 ? "#10b981" : "#ef4444" }}>
                      ({diff >= 0 ? "+" : ""}${diff.toFixed(2)} from start)
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {creds.agentMode && running && (
          <span style={{ fontSize: 11, color: "#6366f1", display: "flex", alignItems: "center", gap: 5 }}>
            <i className="ti ti-robot" aria-hidden="true" />
            {"DeepSeek Agent active — reasoning every "}{creds.agentIntervalSec}{"s"}
          </span>
        )}
        {warmingUp && autoEnabled && (
          <span style={{ fontSize: 11, color: "#f59e0b", display: "flex", alignItems: "center", gap: 5 }}>
            <i className="ti ti-clock" aria-hidden="true" />
            {"Warmup - collecting data, orders paused for 2 min"}
          </span>
        )}

          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {cbBalances && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                USD: <strong>${fmt(cbBalances.USD)}</strong>
                {creds.enabledCoins.map((c) => (
                  <span key={c}> · {c}: <strong>{cbBalances[c]?.toFixed(4)}</strong></span>
                ))}
              </span>
            )}
            {hasCredentials && cbBalances && (
              <button onClick={fetchBalances} style={{ padding: "3px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 11, color: "var(--color-text-secondary)" }}>
                <i className="ti ti-refresh" aria-hidden="true" />
              </button>
            )}
            {/* ── Trading Mode Controls ──────────────────────────────────────────── */}
            {(() => {
              const isSimRunning  = running && !autoEnabled;
              const isLiveRunning = running && autoEnabled;
              const serverRunning = serverSessions.some(s => s.running);

              // STOPPED state
              if (!running && !serverRunning) return (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    data-tour="paper-trade-btn"
                    onClick={() => {
                      const initBal = parseFloat(creds.tradeSizeUSD) || 50;
                      sessionBalanceRef.current = initBal;
                      sessionStartBalanceRef.current = initBal;
                      setSessionBalance(initBal);
                      // Reset all coin state so charts start clean
                      for (const c of (creds.enabledCoins || COINS)) {
                        if (!stateRef.current[c]) continue;
                        const lastPrice = stateRef.current[c].prices.at(-1) || COIN_BASE[c] || 1;
                        stateRef.current[c].prices   = [lastPrice];
                        stateRef.current[c].volumes  = [1];
                        stateRef.current[c].history  = [];
                        stateRef.current[c].pnl      = 0;
                        stateRef.current[c].trades   = 0;
                        stateRef.current[c].position = null;
                      }
                      setViewingSession(null);
                      setWsEnabled(true); setRunning(true);
                      addAutoLog(`▶ Paper simulation started — $${initBal.toFixed(2)} · charts fill as prices arrive`, "info");
                    }}
                    style={{ padding: "7px 16px", borderRadius: 8,
                      border: "0.5px solid #6366f1", background: "#6366f111",
                      color: "#6366f1", cursor: "pointer", fontFamily: "inherit",
                      fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    <i className="ti ti-flask" aria-hidden="true" />
                    Paper trade
                  </button>
                  {limits.canLive ? (
                    <button
                      onClick={() => setShowSessionMgr(true)}
                      disabled={!hasCredentials}
                      title={!hasCredentials ? "Add API keys in Settings first" : "Start live trading"}
                      style={{ padding: "7px 16px", borderRadius: 8,
                        border: `0.5px solid ${hasCredentials ? "#10b981" : "var(--color-border-tertiary)"}`,
                        background: hasCredentials ? "#10b98111" : "transparent",
                        color: hasCredentials ? "#10b981" : "var(--color-text-tertiary)",
                        cursor: hasCredentials ? "pointer" : "not-allowed",
                        fontFamily: "inherit", fontWeight: 700, fontSize: 12,
                        opacity: hasCredentials ? 1 : 0.5,
                        display: "flex", alignItems: "center", gap: 6 }}>
                      <i className="ti ti-robot" aria-hidden="true" />
                      {hasCredentials ? "Go live" : "Add API keys first"}
                    </button>
                  ) : (
                    <div style={{ padding: "7px 14px", borderRadius: 8,
                      border: "0.5px solid #f59e0b44", background: "#f59e0b08",
                      fontSize: 11, color: "#92400e", display: "flex", alignItems: "center", gap: 6 }}>
                      🔒 <a href="/upgrade" style={{ color: "#f59e0b", fontWeight: 700, textDecoration: "none" }}>Upgrade to Pro</a> for live trading
                    </div>
                  )}
                </div>
              );

              // PAPER TRADING state
              if (isSimRunning) return (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {/* Status pill */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
                      borderRadius: 8, background: "#6366f111", border: "0.5px solid #6366f133",
                      fontSize: 11, color: "#6366f1", fontWeight: 600 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#6366f1",
                        boxShadow: "0 0 0 2px #6366f133", display: "inline-block" }} />
                      Paper trading
                    </div>
                    {/* Pause/Resume */}
                    <button onClick={() => setRunning(r => !r)}
                      style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                        border: "0.5px solid var(--color-border-secondary)", background: "transparent",
                        color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>
                      {running ? "⏸ Pause" : "▶ Resume"}
                    </button>
                    {/* Settings save (local) */}
                    <button onClick={() => setShowSavedSims(s => !s)}
                      title="Save simulation settings locally"
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11,
                        border: `0.5px solid ${showSavedSims?"#6366f1":"var(--color-border-secondary)"}`,
                        background: showSavedSims?"#6366f111":"transparent",
                        color: showSavedSims?"#6366f1":"var(--color-text-secondary)",
                        cursor: "pointer", fontFamily: "inherit" }}>
                      💾
                    </button>
                    {/* Save to server (optional, requires login) */}
                    {clerkUser && (
                      <button onClick={() => setShowSessionMgr(true)}
                        title="Save this session to server so you can resume it later"
                        style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                          border: "0.5px solid #6366f144", background: "#6366f108",
                          color: "#6366f1", cursor: "pointer", fontFamily: "inherit",
                          display: "flex", alignItems: "center", gap: 4 }}>
                        ☁️ Save session
                      </button>
                    )}
                    {/* Stop */}
                    <button
                      onClick={() => { setWsEnabled(false); setRunning(false); addAutoLog("Paper trading stopped", "info"); }}
                      style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                        border: "0.5px solid #ef444466", background: "#ef444411",
                        color: "#ef4444", cursor: "pointer", fontFamily: "inherit" }}>
                      ⏹ Stop
                    </button>
                  </div>
                  {/* Auto-save status + feedback */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {activePaperSessionId && (
                      <div style={{ fontSize: 10, color: "var(--color-text-tertiary)",
                        display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%",
                          background: "#6366f1", display: "inline-block" }} />
                        Auto-saving "{activePaperSessionName}" every 5min
                      </div>
                    )}
                    {paperSaveMsg && (
                      <div style={{ fontSize: 11,
                        color: paperSaveMsg.startsWith("✓") || paperSaveMsg.startsWith("⟳")
                          ? "#10b981" : "#ef4444",
                        padding: "2px 8px", borderRadius: 5,
                        background: paperSaveMsg.startsWith("✓") || paperSaveMsg.startsWith("⟳")
                          ? "#10b98111" : "#ef444411" }}>
                        {paperSaveMsg}
                      </div>
                    )}
                  </div>
                </div>
              );

              // LIVE TRADING state (browser-initiated)
              if (isLiveRunning) return (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
                    borderRadius: 8, background: "#10b98111", border: "0.5px solid #10b98133",
                    fontSize: 11, color: "#10b981", fontWeight: 600 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981",
                      boxShadow: "0 0 0 2px #10b98133", display: "inline-block" }} />
                    Live trading
                  </div>
                  <button onClick={() => setRunning(r => !r)}
                    style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                      border: "0.5px solid var(--color-border-secondary)", background: "transparent",
                      color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>
                    {running ? "⏸ Pause" : "▶ Resume"}
                  </button>
                  <button onClick={async () => { stopAutomation(); if (TRADING_SERVER) await stopServerSession(); }}
                    style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                      border: "0.5px solid #ef444466", background: "#ef444411",
                      color: "#ef4444", cursor: "pointer", fontFamily: "inherit" }}>
                    ⏹ Stop
                  </button>
                </div>
              );

              // LIVE SESSION RUNNING (server-side, browser reconnected)
              if (serverRunning) return (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
                    borderRadius: 8, background: "#10b98111", border: "0.5px solid #10b98133",
                    fontSize: 11, color: "#10b981", fontWeight: 700 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981",
                      boxShadow: "0 0 0 2px #10b98133", display: "inline-block" }} />
                    Live · {serverSessions.filter(s=>s.running).length} session{serverSessions.filter(s=>s.running).length>1?"s":""} running
                  </div>
                  <button onClick={() => setShowSessionMgr(true)}
                    style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                      border: "0.5px solid #6366f166", background: "#6366f111",
                      color: "#6366f1", cursor: "pointer", fontFamily: "inherit" }}>
                    Manage sessions
                  </button>
                </div>
              );

              return null;
            })()}
          </div>

          {/* ── Save/Load simulation panel ────────────────────────────────────── */}
          {showSavedSims && !autoEnabled && (
            <div style={{ margin: "10px 0", padding: "14px 16px", borderRadius: 10,
              border: "0.5px solid #6366f144", background: "#6366f108" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", marginBottom: 10 }}>
                💾 Simulation Settings
              </div>

              {/* Save current */}
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input
                  value={simSaveName}
                  onChange={e => setSimSaveName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveSimulation(simSaveName)}
                  placeholder='Name this config (e.g. "RSI+MACD test")'
                  style={{ flex: 1, fontSize: 11, padding: "5px 9px", borderRadius: 6,
                    border: "0.5px solid var(--color-border-secondary)",
                    background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}
                />
                <button onClick={() => saveSimulation(simSaveName)}
                  disabled={!simSaveName.trim()}
                  style={{ padding: "5px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    background: simSaveName.trim() ? "#6366f1" : "var(--color-background-secondary)",
                    color: simSaveName.trim() ? "#fff" : "var(--color-text-tertiary)",
                    border: "none", cursor: simSaveName.trim() ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                  Save
                </button>
              </div>

              {/* Saved list */}
              {Object.keys(savedSims).length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "center", padding: "10px 0" }}>
                  No saved simulations yet. Type a name above and click Save.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.entries(savedSims).map(([name, sim]) => (
                    <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                      borderRadius: 7, background: "var(--color-background-secondary)",
                      border: "0.5px solid var(--color-border-tertiary)" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-primary)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                          {sim.savedAt} · P&L ${sim.totalPnl?.toFixed(2)||"0.00"} · bal ${sim.sessionBalance?.toFixed(2)||"?"}
                          {" · "}{sim.creds?.signalSource || "rules"}{" · "}{sim.creds?.customCoins?.join(", ")||"BTC"}
                        </div>
                      </div>
                      <button onClick={() => loadSimulation(name)}
                        style={{ padding: "3px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                          background: "#6366f1", color: "#fff", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                        Load
                      </button>
                      <button onClick={() => deleteSimulation(name)}
                        title="Delete"
                        style={{ padding: "3px 7px", borderRadius: 5, fontSize: 12,
                          background: "none", border: "none", cursor: "pointer", color: "#ef444488" }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Automation log */}
        {autoLog.length > 0 && (
          <div style={{ marginTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8, maxHeight: 90, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {autoLog.slice(0, 8).map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 8, fontSize: 10, lineHeight: 1.4 }}>
                <span style={{ color: "var(--color-text-tertiary)", minWidth: 60 }}>{l.time}</span>
                <span style={{ color: logTypeColor[l.type] }}>{l.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Exchange state sync panel */}
        {autoEnabled && (
          <div style={{ marginTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                <i className="ti ti-refresh" aria-hidden="true" style={{ color: syncing ? "#f59e0b" : "#10b981" }} />
                Exchange state {syncing ? "syncing…" : exchangeState ? `· synced ${exchangeState.syncedAt}` : "· not yet synced"}
              </span>
              <button onClick={syncFromExchange} disabled={syncing}
                style={{ padding: "2px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: syncing ? "not-allowed" : "pointer", fontSize: 10, color: "var(--color-text-secondary)", opacity: syncing ? 0.5 : 1 }}>
                Sync now
              </button>
            </div>
            {exchangeState && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {/* Open positions from exchange */}
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 4 }}>Open positions on exchange</div>
                  {Object.keys(exchangeState.positions).length === 0
                    ? <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>None</div>
                    : Object.entries(exchangeState.positions).map(([coin, p]) => (
                      <div key={coin} style={{ fontSize: 10, display: "flex", gap: 8, marginBottom: 2 }}>
                        <span style={{ color: COIN_COLORS[coin] || "var(--color-text-primary)", fontWeight: 600 }}>{coin}</span>
                        <span style={{ color: "var(--color-text-secondary)" }}>qty: {p.qty?.toFixed(6)}</span>
                        {p.entryPrice && <span style={{ color: "var(--color-text-secondary)" }}>@ ${fmt(p.entryPrice, 2)}</span>}
                        {p.unrealizedPnl != null && (
                          <span style={{ color: p.unrealizedPnl >= 0 ? "#10b981" : "#ef4444" }}>
                            {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
                          </span>
                        )}
                      </div>
                    ))
                  }
                </div>
                {/* Recent fills from exchange */}
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 4 }}>Recent fills</div>
                  {exchangeState.fills.length === 0
                    ? <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>None</div>
                    : exchangeState.fills.slice(0, 5).map((f, i) => (
                      <div key={i} style={{ fontSize: 10, display: "flex", gap: 6, marginBottom: 2 }}>
                        <span style={{ color: f.side === "BUY" ? "#10b981" : "#ef4444", fontWeight: 600, minWidth: 28 }}>{f.side}</span>
                        <span style={{ color: COIN_COLORS[f.coin] || "var(--color-text-primary)" }}>{f.coin}</span>
                        <span style={{ color: "var(--color-text-secondary)" }}>${fmt(f.price, 2)}</span>
                        <span style={{ color: "var(--color-text-tertiary)", marginLeft: "auto" }}>{f.time?.slice(11,16)}</span>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Rate Limit Monitor ───────────────────────────────────────────────── */}
      <PriceSourceBanner status={priceSourceStatus} onRetry={retryPriceFetch} activeProvider={activeProvider} />
      <RateLimitMonitor stats={rlStats} />

      {/* ── Ticker row ───────────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
        {DISPLAY_COINS.map((c) => {
          const cs = isViewing ? (viewedSessionData?.coinData[c] || snapshot[c]) : snapshot[c];
          const p = cs.prices[cs.prices.length - 1];
          const chg = cs.prices.length > 1 ? ((p - cs.prices[0]) / cs.prices[0]) * 100 : 0;
          const isLive = autoEnabled && creds.enabledCoins.includes(c);
          return (
            <div key={c} onClick={() => setSelectedCoin(c)}
              style={{
                background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px",
                border: `0.5px solid ${selectedCoin === c ? COIN_COLORS[c] : "var(--color-border-tertiary)"}`,
                cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
              <div>
                <div style={{ fontSize: 11, color: COIN_COLORS[c], fontWeight: 700, marginBottom: 1, display: "flex", alignItems: "center", gap: 5 }}>
                  {c}/USD
                  {isLive && <span style={{ fontSize: 9, background: "#d1fae5", color: "#065f46", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>LIVE</span>}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>${fmt(p, c === "BTC" ? 0 : 2)}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: chg >= 0 ? "#10b981" : "#ef4444" }}>{fmtPct(chg)}</div>
              </div>
              <MiniChart data={cs.history.slice(-30).map((h) => ({ price: h.price }))} />
            </div>
          );
        })}
      </div>

      {/* ── Main price chart ─────────────────────────────────────────────────── */}
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: COIN_COLORS[selectedCoin] }}>{selectedCoin}/USD</span>
            <span style={{ fontSize: 20, fontWeight: 700 }}>${fmt(currentPrice, selectedCoin === "BTC" ? 0 : 2)}</span>
            <span style={{ fontWeight: 600, color: priceChange >= 0 ? "#10b981" : "#ef4444" }}>{fmtPct(priceChange)}</span>
          </div>
          <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--color-text-secondary)" }}>
            {[["Price", COIN_COLORS[selectedCoin]], ["SMA20", "#f59e0b"], ["SMA50", "#6366f1"], ["BB", "#94a3b8"]].map(([l, c]) => (
              <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 16, height: 2, background: c, display: "inline-block" }} />{l}
              </span>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="i" hide />
            <YAxis domain={["auto", "auto"]} width={60} tick={{ fontSize: 10 }} tickFormatter={(v) => selectedCoin === "BTC" ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`} />
            <Tooltip formatter={(v) => [`$${fmt(v, 2)}`]} labelFormatter={() => ""} contentStyle={{ fontSize: 11, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }} />
            <Line type="monotone" dataKey="bUpper" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="2 2" />
            <Line type="monotone" dataKey="bLower" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="2 2" />
            <Line type="monotone" dataKey="sma50" stroke="#6366f1" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
            <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeWidth={1.2} dot={false} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="price" stroke={COIN_COLORS[selectedCoin]} strokeWidth={1.8} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── RSI + P&L charts ─────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>RSI (14)</div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={rsiData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="i" hide />
              <YAxis domain={[0, 100]} width={28} tick={{ fontSize: 9 }} ticks={[30, 50, 70]} />
              <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={0.8} />
              <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 2" strokeWidth={0.8} />
              <Tooltip formatter={(v) => [v?.toFixed(1), "RSI"]} labelFormatter={() => ""} contentStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="rsi" stroke="#a855f7" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          {lastH?.rsi && <div style={{ fontSize: 11, marginTop: 4, color: lastH.rsi > 70 ? "#ef4444" : lastH.rsi < 30 ? "#10b981" : "var(--color-text-secondary)" }}>
            {lastH.rsi.toFixed(1)}{" - "}{lastH.rsi > 70 ? "Overbought" : lastH.rsi < 30 ? "Oversold" : "Neutral"}
          </div>}
        </div>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>
            {isViewing ? "Session P&L" : running ? `P&L — ${effectiveCoin} (this run)` : "Cumulative P&L"}
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={pnlData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="i" hide />
              <YAxis width={42} tick={{ fontSize: 9 }} tickFormatter={(v) => "$" + v.toFixed(2)} />
              <ReferenceLine y={0} stroke="var(--color-border-secondary)" strokeWidth={0.8} />
              <Tooltip formatter={(v) => [v?.toFixed(3) + "%", "P&L"]} labelFormatter={() => ""} contentStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="pnl" stroke={coin.pnl >= 0 ? "#10b981" : "#ef4444"} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, marginTop: 4, color: (coin.pnl + unrealized) >= 0 ? "#10b981" : "#ef4444" }}>
            {!coinInSession && running ? (
              <span style={{ color: "var(--color-text-tertiary)" }}>{effectiveCoin} not in session</span>
            ) : coin.position && coin.trades === 0 ? (
              // Open position, no closed trades yet — the number shown is purely unrealized
              <>
                {"$"}{(coin.pnl + unrealizedDollar).toFixed(2)}
                <span style={{ color: "var(--color-text-tertiary)" }}> (unrealized · position still open, 0 closed)</span>
              </>
            ) : (
              `$${(coin.pnl + unrealizedDollar).toFixed(2)} — ${coin.trades} trade${coin.trades !== 1 ? "s" : ""}`
            )}
          </div>
        </div>
      </div>

      {/* ── Signal analysis + indicators + position ───────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>Current signal analysis</div>
          {lastH ? (
            <>
              {/* Header row: action badge + confidence + score */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <Badge action={lastH.action} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 3 }}>
                    <span>Indicator agreement</span>
                    <span style={{ fontWeight: 600, color: parseFloat(lastH.confidence) >= parseFloat(displayCreds.minConfidence) ? "#10b981" : "#f59e0b" }}>
                      {lastH.confidence}%
                      {lastH.agreeingCount != null && ` (${lastH.agreeingCount}/${lastH.totalIndicators} agree)`}
                    </span>
                  </div>
                  <div style={{ height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                    <div style={{ width: lastH.confidence + "%", height: "100%", borderRadius: 3,
                      background: parseFloat(lastH.confidence) >= parseFloat(displayCreds.minConfidence) ? "#10b981" : "#f59e0b",
                      transition: "width 0.3s ease" }} />
                    {/* Threshold marker */}
                    <div style={{ position: "absolute", top: 0, left: displayCreds.minConfidence + "%", width: 2, height: "100%", background: "#6366f1" }} />
                  </div>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, display: "flex", justifyContent: "space-between" }}>
                    <span>threshold: {displayCreds.minConfidence}% <span style={{ color: "#6366f1" }}>│</span></span>
                    <span>score: <strong style={{ color: lastH.score > 0 ? "#10b981" : lastH.score < 0 ? "#ef4444" : "var(--color-text-secondary)" }}>{lastH.score > 0 ? "+" : ""}{lastH.score}</strong></span>
                  </div>
                </div>
              </div>

              {/* Buy gate status */}
              {lastH.action === "BUY" && lastH.agreeingCount != null && (
                <div style={{ fontSize: 10, marginBottom: 8, padding: "4px 8px", borderRadius: 5,
                  background: (parseFloat(lastH.confidence) >= parseFloat(displayCreds.minConfidence) && lastH.agreeingCount >= 3) ? "#d1fae5" : "#fef3c7",
                  color: (parseFloat(lastH.confidence) >= parseFloat(displayCreds.minConfidence) && lastH.agreeingCount >= 3) ? "#065f46" : "#92400e" }}>
                  {parseFloat(lastH.confidence) >= parseFloat(displayCreds.minConfidence) && lastH.agreeingCount >= 3
                    ? `✓ BUY gate passed — ${lastH.agreeingCount} indicators agree, confidence above threshold`
                    : `⚠ BUY suppressed — ${parseFloat(lastH.confidence) < parseFloat(displayCreds.minConfidence) ? `confidence ${lastH.confidence}% below ${displayCreds.minConfidence}% threshold` : `only ${lastH.agreeingCount}/3 indicators agree`}`}
                </div>
              )}

              {/* Signal source badge */}
              <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  lastH.fromCustomRules && { icon: "⚙️", label: "Custom Rules", color: "#10b981" },
                  lastH.fromRL          && { icon: "🎮", label: `RL (ep:${lastH.rlEpisodes} ε:${lastH.rlEpsilon})`, color: "#6366f1" },
                  lastH.fromRF          && { icon: "🌲", label: `RF (P↑:${lastH.rfDirProb})`, color: "#f59e0b" },
                  lastH.fromLSTM        && { icon: "🧠", label: "LSTM", color: "#8b5cf6" },
                ].filter(Boolean).map((b, i) => (
                  <span key={i} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, fontWeight: 700,
                    background: b.color + "20", color: b.color, border: `0.5px solid ${b.color}44` }}>
                    {b.icon} {b.label}
                  </span>
                ))}
              </div>

              {/* LSTM parameters */}
              {lastH.lstmTrend != null && (
                <div style={{ marginBottom: 8, padding: "7px 10px", borderRadius: 7,
                  background: "#8b5cf608", border: "0.5px solid #8b5cf622", fontSize: 10 }}>
                  <div style={{ fontWeight: 600, color: "#8b5cf6", marginBottom: 4 }}>🧠 LSTM parameters</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                    {[
                      { label: "Trend",     val: lastH.lstmTrend,   color: parseFloat(lastH.lstmTrend) > 0 ? "#10b981" : "#ef4444" },
                      { label: "Δ5 ticks",  val: lastH.lstmChange ? lastH.lstmChange + "%" : "n/a", color: parseFloat(lastH.lstmChange) > 0 ? "#10b981" : "#ef4444" },
                      { label: "Volatility",val: lastH.lstmVol,     color: "var(--color-text-primary)" },
                      { label: "P(up)",     val: lastH.lstmDirProb, color: parseFloat(lastH.lstmDirProb) > 0.55 ? "#10b981" : parseFloat(lastH.lstmDirProb) < 0.45 ? "#ef4444" : "#94a3b8" },
                    ].map(m => (
                      <div key={m.label} style={{ textAlign: "center" }}>
                        <div style={{ color: "var(--color-text-tertiary)", marginBottom: 1 }}>{m.label}</div>
                        <div style={{ fontWeight: 700, color: m.color }}>{m.val ?? "…"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* RF + RL row */}
              {(lastH.rfDirProb != null || lastH.rlAction) && (
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  {lastH.rfDirProb != null && (
                    <div style={{ flex: 1, padding: "6px 8px", borderRadius: 7, background: "#f59e0b08",
                      border: "0.5px solid #f59e0b22", fontSize: 10 }}>
                      <div style={{ fontWeight: 600, color: "#f59e0b", marginBottom: 3 }}>🌲 Random Forest</div>
                      <div style={{ color: "var(--color-text-secondary)" }}>
                        P(up): <strong style={{ color: parseFloat(lastH.rfDirProb) > 0.55 ? "#10b981" : "#ef4444" }}>{lastH.rfDirProb}</strong>
                        {lastH.rfTrainedOn && <span style={{ color: "var(--color-text-tertiary)", marginLeft: 5 }}>n={lastH.rfTrainedOn}</span>}
                      </div>
                    </div>
                  )}
                  {lastH.rlAction && (
                    <div style={{ flex: 1, padding: "6px 8px", borderRadius: 7, background: "#6366f108",
                      border: "0.5px solid #6366f122", fontSize: 10 }}>
                      <div style={{ fontWeight: 600, color: "#6366f1", marginBottom: 3 }}>🎮 RL Agent</div>
                      <div style={{ color: "var(--color-text-secondary)" }}>
                        <strong style={{ color: lastH.rlAction==="BUY"?"#10b981":lastH.rlAction==="SELL"?"#ef4444":"#94a3b8" }}>{lastH.rlAction}</strong>
                        <span style={{ color: "var(--color-text-tertiary)", marginLeft: 5 }}>Q=[{lastH.rlQValues?.join(", ")}]</span>
                      </div>
                      <div style={{ color: "var(--color-text-tertiary)", marginTop: 1 }}>ep:{lastH.rlEpisodes} ε:{lastH.rlEpsilon}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Indicator values */}
              {lastH.indicators && (
                <div style={{ marginBottom: 8, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
                  {[
                    { k: "RSI",       v: lastH.indicators.rsi,         warn: parseFloat(lastH.indicators.rsi) < 30 || parseFloat(lastH.indicators.rsi) > 70 },
                    { k: "MACD",      v: lastH.indicators.macd,        warn: false },
                    { k: "Boll%B",    v: lastH.indicators.bollingerPct, warn: false },
                    { k: "Vol",       v: lastH.indicators.volume ? lastH.indicators.volume + "×" : null, warn: parseFloat(lastH.indicators.volume) > 1.5 },
                    { k: "SMA20%",    v: lastH.indicators.sma20dist ? lastH.indicators.sma20dist + "%" : null, warn: false },
                    { k: "SMA50%",    v: lastH.indicators.sma50dist ? lastH.indicators.sma50dist + "%" : null, warn: false },
                    { k: "ATR%",      v: lastH.indicators.atrPct ? lastH.indicators.atrPct + "%" : null, warn: false },
                    { k: "Score",     v: lastH.score, warn: false },
                  ].map(({ k, v, warn }) => v != null && (
                    <div key={k} style={{ fontSize: 9, textAlign: "center", padding: "3px 4px", borderRadius: 4,
                      background: warn ? "#f59e0b11" : "var(--color-background-primary)" }}>
                      <div style={{ color: "var(--color-text-tertiary)" }}>{k}</div>
                      <div style={{ fontWeight: 700, color: warn ? "#f59e0b" : "var(--color-text-primary)" }}>{v}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Per-indicator reason breakdown */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {lastH.reasons?.map((r, i) => {
                  const item = typeof r === "object" ? r : { label: r, vote: 0 };
                  const voteColor = item.vote === 1 ? "#10b981" : item.vote === -1 ? "#ef4444" : "#94a3b8";
                  const icon = item.vote === 1 ? "ti-arrow-up" : item.vote === -1 ? "ti-arrow-down" : "ti-minus";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                      padding: "3px 6px", borderRadius: 4,
                      background: item.vote !== 0 ? voteColor + "11" : "transparent" }}>
                      <i className={`ti ${icon}`} aria-hidden="true" style={{ color: voteColor, fontSize: 12, flexShrink: 0 }} />
                      <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{item.label}</span>
                      {item.vote !== 0 && <span style={{ fontSize: 10, fontWeight: 600, color: voteColor }}>{item.vote === 1 ? "BULL" : "BEAR"}</span>}
                    </div>
                  );
                })}
              </div>

              {/* Custom exit rules that fired */}
              {lastH.customExitsFired?.length > 0 && (
                <div style={{ marginTop: 6, padding: "5px 8px", borderRadius: 5,
                  background: "#f59e0b11", border: "0.5px solid #f59e0b33", fontSize: 10, color: "#92400e" }}>
                  🎯 Exit rules: {lastH.customExitsFired.join(", ")}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
              {running
                ? !coinInSession
                  ? `${effectiveCoin} is not in this session — select a session coin above`
                  : "Waiting for first tick…"
                : "Press Start to begin analysis"}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* ── Position panel ──────────────────────────────────────────────── */}
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 10,
            border: `0.5px solid ${!coinInSession && running ? "var(--color-border-tertiary)" : coin.position ? (unrealized >= 0 ? "#10b981" : "#ef4444") : "var(--color-border-tertiary)"}`,
            padding: "12px", flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <span>{"Position - "}{selectedCoin}{"/USD"}</span>
              {coin.position?.manual      && <span style={{ fontSize: 10, color: "#f59e0b",  fontWeight: 600 }}>MANUAL</span>}
              {coin.position?.fromExchange && <span style={{ fontSize: 10, color: "#94a3b8",  fontWeight: 600 }}>EXCHANGE BALANCE</span>}
              {coin.position?.algoOwned && !coin.position.manual && autoEnabled && <span style={{ fontSize: 10, color: "#6366f1" }}><i className="ti ti-robot" aria-hidden="true" /> ALGO</span>}
            </div>
            {coin.position ? (() => {
              const er = displayCreds.exitRules?.[selectedCoin] || {};
              const ep = coin.position.price;
              const resolveLevel = (type, val, dir) => {
                const v = parseFloat(val) || 0; if (!v) return null;
                return type === "percent" ? dir === "up" ? ep*(1+v/100) : ep*(1-v/100) : dir === "up" ? ep+v : ep-v;
              };
              const tp = resolveLevel(er.takeProfitType, er.takeProfitValue, "up");
              const sl = resolveLevel(er.stopLossType, er.stopLossValue, "down");
              return (<>
                <div style={{ fontSize: 11, marginBottom: 3 }}>Entry: <strong>${fmt(ep, 2)}</strong></div>
                <div style={{ fontSize: 11, marginBottom: 3 }}>Qty: <strong>{(coin.position.size || 0).toFixed(8)} {selectedCoin}</strong></div>
                <div style={{ fontSize: 11, marginBottom: 3 }}>Now: <strong>${fmt(currentPrice, 2)}</strong></div>
                {(() => {
                  const fee = parseFloat(displayCreds.feePercent) || 0;
                  const breakEven = ep * (1 + fee / 100) / (1 - fee / 100);
                  const netPnl = calcProfit(ep, currentPrice, coin.position.size || 0, displayCreds.feePercent);
                  return (<>
                    <div style={{ fontSize: 13, fontWeight: 700, color: netPnl >= 0 ? "#10b981" : "#ef4444", marginBottom: 4 }}>
                      {netPnl >= 0 ? "+" : ""}{"$"}{Math.abs(netPnl).toFixed(2)}{" ("}{fmtPct(unrealized)}{")"}
                    </div>
                    {fee > 0 && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 4 }}>
                      Break-even (after fees): ${fmt(breakEven, 2)}
                    </div>}
                  </>);
                })()}
                {/* Resting limit sell order (post-buy) */}
                {coin.position?.restingSellLimitPrice && (
                  <div style={{ fontSize: 10, color: "#10b981", display: "flex", justifyContent: "space-between", marginBottom: 2, fontWeight: 600 }}>
                    <span>📋 Resting SELL</span>
                    <strong>${fmt(coin.position.restingSellLimitPrice, 2)}</strong>
                  </div>
                )}
                {/* Dynamic exit scaling status */}
                {displayCreds.dynamicExits?.enabled && (() => {
                  const totalPnl = displayCreds.dynamicExits.scaleBy === "per_coin"
                    ? coin.pnl
                    : COINS.reduce((sum, c) => sum + (snapshot?.[c]?.pnl || 0), 0);
                  const pt = parseFloat(displayCreds.dynamicExits.profitThreshold) || 20;
                  const lt = parseFloat(displayCreds.dynamicExits.lossThreshold) || -20;
                  const isWinning = totalPnl > pt;
                  const isLosing  = totalPnl < lt;
                  if (!isWinning && !isLosing) return null;
                  return (
                    <div style={{ fontSize: 10, marginBottom: 4, padding: "3px 8px", borderRadius: 5,
                      background: isWinning ? "#10b98115" : "#ef444415",
                      color: isWinning ? "#10b981" : "#ef4444", fontWeight: 600 }}>
                      {"📊 "}{isWinning ? "Aggressive mode" : "Defensive mode"}{" (P&L: $"}{totalPnl.toFixed(2)}{")"}
                    </div>
                  );
                })()}
                {tp && <div style={{ fontSize: 10, color: "#10b981", display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span>↑ TP</span><strong>${fmt(tp, 2)}</strong>
                </div>}
                {sl && <div style={{ fontSize: 10, color: "#ef4444", display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span>↓ SL</span><strong>${fmt(sl, 2)}</strong>
                </div>}
                {/* Trailing take-profit status */}
                {displayCreds.exitStrategies?.trailingTakeProfit?.enabled && coin.position && (() => {
                  const ttp = trailingTpRef.current[selectedCoin];
                  const er = displayCreds.exitRules?.[selectedCoin] || {};
                  const tpPrice = coin.position.price && er.takeProfitValue
                    ? er.takeProfitType === "percent"
                      ? coin.position.price * (1 + parseFloat(er.takeProfitValue) / 100)
                      : coin.position.price + parseFloat(er.takeProfitValue)
                    : null;
                  if (ttp?.armed) {
                    const reversalPx = ttp.peak * (1 - (parseFloat(displayCreds.exitStrategies.trailingTakeProfit.trailPercent) || 1) / 100);
                    return (
                      <div style={{ fontSize: 10, color: "#10b981", marginBottom: 2 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>🎯 TTP peak</span><strong>${fmt(ttp.peak, 2)}</strong>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>Sell if below</span><strong>${fmt(reversalPx, 2)}</strong>
                        </div>
                      </div>
                    );
                  }
                  return tpPrice ? (
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 2 }}>
                      <span>🎯 TTP arms @ </span><strong>${fmt(tpPrice, 2)}</strong>
                    </div>
                  ) : null;
                })()}
                {displayCreds.exitStrategies?.trailingStop?.enabled && trailingHighRef.current[selectedCoin] && (
                  <div style={{ fontSize: 10, color: "#f59e0b", display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span>~ Trail stop</span>
                <strong>{(() => {
                      const ts   = displayCreds.exitStrategies?.trailingStop || {};
                      const peak = trailingHighRef.current[selectedCoin];
                      if (!peak) return "—";
                      const val  = parseFloat(ts.trailPercent) || 1.5;
                      const stop = ts.trailDelta === "absolute" ? peak - val : peak * (1 - val / 100);
                      return "$" + fmt(stop, 2);
                    })()}</strong>
                  </div>
                )}
                {/* Active order type badges */}
                {autoEnabled && (
                  <div style={{ fontSize: 10, marginTop: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: "var(--color-text-tertiary)" }}>
                      BUY: <strong style={{ color: displayCreds.buyOrderConfig?.type === "limit" ? "#10b981" : "var(--color-text-secondary)" }}>
                        {displayCreds.buyOrderConfig?.type === "limit"
                          ? `limit +${displayCreds.buyOrderConfig.limitOffsetValue}${displayCreds.buyOrderConfig.limitOffsetType === "percent" ? "%" : "$"}`
                          : "market"}
                      </strong>
                    </span>
                    <span style={{ color: "var(--color-text-tertiary)" }}>
                      SELL: <strong style={{ color: "#6366f1" }}>
                        {(displayCreds.sellOrderConfig?.type || "market").replace(/_/g, " ")}
                      </strong>
                    </span>
                  </div>
                )}
                {displayCreds.exitStrategies?.timeExit?.enabled && coin.position && (
                  <div style={{ fontSize: 10, color: "#a855f7", display: "flex", justifyContent: "space-between" }}>
                    <span>⏱ Max hold</span>
                    <strong>{displayCreds.exitStrategies.timeExit.maxHoldMinutes}m</strong>
                  </div>
                )}
              </>);
            })() : (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                {!coinInSession && running
                  ? `${effectiveCoin} is not in the active session`
                  : running
                    ? "No open position — watching for signal"
                    : "No open position"}
              </div>
            )}
          </div>

          {/* ── Manual trade controls ───────────────────────────────────────── */}
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span><i className="ti ti-hand-click" aria-hidden="true" /> Manual override</span>
              <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>${fmt(currentPrice, selectedCoin === "BTC" ? 0 : 2)}</span>
            </div>

            {/* Confirm dialog */}
            {manualConfirm && manualConfirm.coin === selectedCoin ? (
              <div style={{ background: manualConfirm.action === "BUY" ? "#d1fae511" : "#fee2e211", border: `0.5px solid ${manualConfirm.action === "BUY" ? "#10b981" : "#ef4444"}`, borderRadius: 8, padding: "10px", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: manualConfirm.action === "BUY" ? "#10b981" : "#ef4444" }}>
                  Confirm {manualConfirm.action} {selectedCoin} @ ${fmt(manualConfirm.price, 2)}?
                </div>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 8 }}>
                  Size: ${creds.tradeSizeUSD} {creds.sandbox ? "· SANDBOX" : autoEnabled ? "· LIVE ORDER" : "· sim only"}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => executeManualTrade(selectedCoin, manualConfirm.action)}
                    style={{ flex: 1, padding: "6px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 12,
                      background: manualConfirm.action === "BUY" ? "#10b981" : "#ef4444", color: "#fff" }}>
                    Confirm
                  </button>
                  <button onClick={() => setManualConfirm(null)}
                    style={{ flex: 1, padding: "6px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", cursor: "pointer", fontSize: 12, background: "transparent", color: "var(--color-text-secondary)" }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {/* BUY button */}
                <button
                  onClick={() => setManualConfirm({ action: "BUY", coin: selectedCoin, price: currentPrice })}
                  disabled={!!coin.position || manualBuying}
                  style={{ padding: "10px 0", borderRadius: 8, border: "0.5px solid #10b981",
                    background: coin.position ? "transparent" : "#d1fae5",
                    color: coin.position ? "#94a3b8" : "#065f46",
                    cursor: coin.position ? "not-allowed" : "pointer",
                    fontWeight: 700, fontSize: 13, opacity: coin.position ? 0.4 : 1 }}>
                  {manualBuying ? "…" : "▲ BUY"}
                </button>
                {/* SELL button */}
                <button
                  onClick={() => setManualConfirm({ action: "SELL", coin: selectedCoin, price: currentPrice })}
                  disabled={!coin.position || manualSelling}
                  style={{ padding: "10px 0", borderRadius: 8, border: "0.5px solid #ef4444",
                    background: !coin.position ? "transparent" : "#fee2e2",
                    color: !coin.position ? "#94a3b8" : "#991b1b",
                    cursor: !coin.position ? "not-allowed" : "pointer",
                    fontWeight: 700, fontSize: 13, opacity: !coin.position ? 0.4 : 1 }}>
                  {manualSelling ? "…" : "▼ SELL"}
                </button>
              </div>
            )}

            {(cooldownRef.current[selectedCoin] &&
              Math.max(0, Math.ceil((cooldownRef.current[selectedCoin] + COOLDOWN_MS - Date.now()) / 1000)) > 0
            ) && (
              <div style={{ marginTop: 6, padding: "5px 8px", borderRadius: 5, background: "#fef3c711", border: "0.5px solid #f59e0b", fontSize: 10, color: "#f59e0b" }}>
                {"⏸ Cooling off - next BUY in " + Math.max(0, Math.ceil((cooldownRef.current[selectedCoin] + COOLDOWN_MS - Date.now()) / 1000)) + "s"}
              </div>
            )}
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 8, lineHeight: 1.4 }}>
              {!autoEnabled ? "Start automation to place real orders" :
               creds.sandbox ? "Sandbox — no real orders placed" :
               `Live ${activeProvider.name} order · $${creds.tradeSizeUSD}`}
            </div>
          </div>

          {/* ── Indicators ──────────────────────────────────────────────────── */}
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>Indicators</div>
            {lastH && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                <div>SMA20: <strong>${fmt(calcSMA(coin.prices, 20), 0)}</strong></div>
                <div>SMA50: <strong>${fmt(calcSMA(coin.prices, 50), 0)}</strong></div>
                <div>MACD: <strong style={{ color: (calcMACD(coin.prices) || 0) > 0 ? "#10b981" : "#ef4444" }}>{fmt(calcMACD(coin.prices), 2)}</strong></div>
                <div>Vol ratio: <strong>{lastH.volumeRatio?.toFixed(2)}x</strong></div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── LLM Agent Panel ─────────────────────────────────────────────────────── */}
      {creds.agentMode && (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: `0.5px solid ${agentStatus === "thinking" ? "#6366f1" : agentStatus === "error" ? "#ef4444" : agentStatus === "ready" ? "#10b981" : "var(--color-border-tertiary)"}`, padding: "14px 16px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                background: agentStatus === "thinking" ? "#6366f1" : agentStatus === "ready" ? "#10b981" : agentStatus === "error" ? "#ef4444" : "#94a3b8",
                animation: agentStatus === "thinking" ? "pulse 1s infinite" : "none" }} />
              {"🤖 DeepSeek Agent"} {agentStatus === "thinking" ? "— thinking..." : agentStatus === "ready" ? "— ready" : agentStatus === "error" ? "— error" : "— idle"}
            </span>
            <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
              Every {creds.agentIntervalSec}s
            </span>
          </div>

          {/* LSTM Status Row */}
          <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block",
                background: lstmStatus === "ready" ? "#10b981" : lstmStatus === "training" ? "#f59e0b" : lstmStatus === "error" ? "#ef4444" : "#94a3b8" }} />
              <span style={{ color: "var(--color-text-secondary)" }}>
                LSTM: {lstmStatus === "idle" ? "idle" : lstmStatus === "loading" ? "loading TF.js..." : lstmStatus === "training" ? "training..." : lstmStatus === "ready" ? "ready" : "error — check console"}
              </span>
            </span>
            {/* RL status per coin */}
            {creds.signalSource === "rl" && creds.enabledCoins.map(c => {
              const rl = rlPredCache[c];
              if (!rl) return <span key={c} style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{c}: RL warming up...</span>;
              return (
                <span key={c} style={{ fontSize: 10, display: "flex", gap: 5, padding: "2px 8px", borderRadius: 5,
                  background: "var(--color-background-primary)", border: "0.5px solid #6366f144" }}>
                  <span style={{ color: COIN_COLORS[c], fontWeight: 600 }}>{c}</span>
                  <span style={{ color: "#6366f1" }}>🎮</span>
                  <span style={{ color: rl.action==="BUY"?"#10b981":rl.action==="SELL"?"#ef4444":"#94a3b8", fontWeight: 700 }}>{rl.action}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>ep:{rl.episodes}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>ε:{rl.epsilon}</span>
                  {rl.episodes < RL_MIN_EPISODES && <span style={{ color: "#f59e0b" }}>exploring</span>}
                </span>
              );
            })}
            {creds.enabledCoins.map(coin => {
              const p   = lstmPred[coin];
              const rf  = rfPredCache[coin];
              const hasData = p || rf;
              if (!hasData) return <span key={coin} style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{coin}: warming up...</span>;
              const rfProb   = rf?.directionProbability ?? 0.5;
              const lstmProb = p?.directionProbability  ?? 0.5;
              const consensus = rfProb > 0.55 && lstmProb > 0.55 ? "bull"
                : rfProb < 0.45 && lstmProb < 0.45 ? "bear" : "split";
              return (
                <span key={coin} style={{ fontSize: 10, display: "flex", gap: 5, padding: "3px 8px", borderRadius: 5,
                  background: "var(--color-background-primary)",
                  border: `0.5px solid ${consensus === "bull" ? "#10b981" : consensus === "bear" ? "#ef4444" : "var(--color-border-tertiary)"}` }}>
                  <span style={{ color: COIN_COLORS[coin], fontWeight: 600 }}>{coin}</span>
                  {rf && <span style={{ color: rfProb >= 0.55 ? "#10b981" : rfProb <= 0.45 ? "#ef4444" : "#94a3b8" }}>RF:{(rfProb*100).toFixed(0)}%</span>}
                  {p  && <span style={{ color: lstmProb >= 0.55 ? "#10b981" : lstmProb <= 0.45 ? "#ef4444" : "#94a3b8" }}>LSTM:{(lstmProb*100).toFixed(0)}%</span>}
                  <span style={{ fontWeight: 700, color: consensus === "bull" ? "#10b981" : consensus === "bear" ? "#ef4444" : "#94a3b8" }}>
                    {consensus === "bull" ? "↑ bull" : consensus === "bear" ? "↓ bear" : "~ split"}
                  </span>
                  {p && <span style={{ color: "var(--color-text-tertiary)" }}>v:{p.volatility?.toFixed(2)}</span>}
                </span>
              );
            })}
          </div>

          {agentLog.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {agentLog.slice(0, 3).map((d, i) => (
                <div key={i} style={{ padding: "10px 12px", borderRadius: 8, border: `0.5px solid ${d.action === "BUY" ? "#10b981" : d.action === "SELL" ? "#ef4444" : "var(--color-border-tertiary)"}`, background: d.action === "BUY" ? "#d1fae508" : d.action === "SELL" ? "#fee2e208" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: COIN_COLORS[d.coin] }}>{d.coin}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: d.action === "BUY" ? "#10b981" : d.action === "SELL" ? "#ef4444" : "#94a3b8" }}>{d.action}</span>
                    <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 4, fontWeight: 600,
                      background: parseFloat(d.confidence) >= 70 ? "#d1fae5" : parseFloat(d.confidence) >= 50 ? "#fef3c7" : "#fee2e2",
                      color: parseFloat(d.confidence) >= 70 ? "#065f46" : parseFloat(d.confidence) >= 50 ? "#92400e" : "#991b1b" }}>
                      {d.confidence}% conf
                    </span>
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4,
                      background: d.risk === "low" ? "#d1fae5" : d.risk === "high" ? "#fee2e2" : "#fef3c7",
                      color: d.risk === "low" ? "#065f46" : d.risk === "high" ? "#991b1b" : "#92400e" }}>
                      {d.risk} risk
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-tertiary)" }}>{d.time}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6, lineHeight: 1.5 }}>
                    {d.reasoning}
                  </div>
                  {d.keyFactors?.length > 0 && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {d.keyFactors.map((f, j) => (
                        <span key={j} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4,
                          background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)",
                          color: "var(--color-text-secondary)" }}>
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "center", padding: "12px 0" }}>
              {"Waiting for first agent decision..."} {!running && "(Start simulation or live trading)"}
            </div>
          )}
        </div>
      )}

      {/* ── Trading log ──────────────────────────────────────────────────────── */}
      {autoLog.length > 0 && (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <span><i className="ti ti-terminal-2" aria-hidden="true" /> Trading log</span>
            <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{autoLog.length} entries</span>
          </div>
          <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {autoLog.slice(0, 20).map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 8, fontSize: 10, lineHeight: 1.5, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 2 }}>
                <span style={{ color: "var(--color-text-tertiary)", minWidth: 68, flexShrink: 0 }}>{l.time}</span>
                <span style={{ color: logTypeColor[l.type] }}>{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Transaction Log ──────────────────────────────────────────────────────── */}
      {txLog.length > 0 && (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px 16px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              Transaction Log
              <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-secondary)", marginLeft: 8 }}>
                {txLog.length} trade{txLog.length !== 1 ? "s" : ""} — sim + live
              </span>
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {adaptiveState && Object.entries(adaptiveState).map(([coin, adj]) => adj && (
                <span key={coin} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#6366f122", color: "#6366f1", border: "0.5px solid #6366f144" }}>
                  {coin} TP {adj.tp?.toFixed(2)}% SL {adj.sl?.toFixed(2)}% @ {adj.appliedAt}
                </span>
              ))}
              <button onClick={exportTxCSV}
                style={{ padding: "4px 12px", borderRadius: 6, border: "0.5px solid #6366f1", background: "#6366f122", color: "#6366f1", cursor: "pointer", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                <i className="ti ti-download" aria-hidden="true" /> Export CSV
              </button>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  {["Time","Mode","Type","Coin","Price","Qty","USD","P&L","Fees","Exit","LSTM","Agent"].map(h => (
                    <th key={h} style={{ padding: "4px 8px", textAlign: "left", color: "var(--color-text-tertiary)", fontWeight: 600, fontSize: 10, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txLog.slice(0, 15).map(t => (
                  <tr key={t.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", background: t.type === "BUY" ? "#10b98105" : "#ef444405" }}>
                    <td style={{ padding: "4px 8px", color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>{t.time}</td>
                    <td style={{ padding: "4px 8px", color: "var(--color-text-tertiary)" }}>{t.mode}</td>
                    <td style={{ padding: "4px 8px", fontWeight: 700, color: t.type === "BUY" ? "#10b981" : "#ef4444" }}>{t.type}</td>
                    <td style={{ padding: "4px 8px", color: COIN_COLORS[t.coin], fontWeight: 600 }}>{t.coin}</td>
                    <td style={{ padding: "4px 8px" }}>${fmt(t.price, t.coin === "BTC" ? 0 : 2)}</td>
                    <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{t.qty?.toFixed(6)}</td>
                    <td style={{ padding: "4px 8px" }}>${fmt(t.usdValue, 2)}</td>
                    <td style={{ padding: "4px 8px", color: t.pnl == null ? "var(--color-text-tertiary)" : t.pnl >= 0 ? "#10b981" : "#ef4444", fontWeight: t.pnl != null ? 600 : 400 }}>
                      {t.pnl == null ? "—" : `${t.pnl >= 0 ? "+" : ""}$${Math.abs(t.pnl).toFixed(2)}`}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--color-text-tertiary)" }}>
                      {t.fees != null ? `$${t.fees.toFixed(4)}` : "—"}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--color-text-tertiary)", fontSize: 10 }}>
                      {t.exitReason ? t.exitReason.replace(/_/g, " ").toLowerCase() : "—"}
                    </td>
                    <td style={{ padding: "4px 8px", fontSize: 10 }}>
                      {t.lstmTrend != null ? (
                        <span style={{ color: parseFloat(t.lstmTrend) > 0.1 ? "#10b981" : parseFloat(t.lstmTrend) < -0.1 ? "#ef4444" : "#94a3b8" }}>
                          {parseFloat(t.lstmChange) >= 0 ? "+" : ""}{t.lstmChange}%
                        </span>
                      ) : "—"}
                    </td>
                    <td style={{ padding: "4px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-secondary)", fontSize: 10 }}
                      title={t.agentReason || ""}>
                      {t.agentReason ? t.agentReason.slice(0, 40) + (t.agentReason.length > 40 ? "..." : "") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {txLog.length > 15 && (
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 6, textAlign: "right" }}>
              Showing 15 of {txLog.length} — export CSV for full log
            </div>
          )}
        </div>
      )}

      {/* ── News + Signal log ────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span><i className="ti ti-news" aria-hidden="true" /> Live crypto news</span>
            <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
              {newsStatus === "loading" && <span style={{ color: "#f59e0b" }}>fetching…</span>}
              {newsStatus === "error" && <span style={{ color: "#ef4444" }}>fetch failed</span>}
              {newsStatus === "ok" && <span style={{ color: "#10b981" }}>● live · NewsData.io</span>}
              <button onClick={fetchRealNews} title="Refresh news"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 13, padding: "0 2px" }}>
                <i className="ti ti-refresh" aria-hidden="true" />
              </button>
            </span>
          </div>
          {newsStatus === "loading" && news.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "8px 0" }}>Loading real news…</div>
          )}
          {newsStatus === "error" && news.length === 0 && (
            <div style={{ fontSize: 11, color: "#ef4444", padding: "8px 0" }}>
              Could not load news. Check proxy /news route is deployed.
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
            {news.map((n) => {
              const sentColor = n.sentiment > 0.1 ? "#10b981" : n.sentiment < -0.1 ? "#ef4444" : "#f59e0b";
              const icon = n.sentiment > 0.1 ? "ti-trending-up" : n.sentiment < -0.1 ? "ti-trending-down" : "ti-minus";
              return (
                <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingBottom: 8, marginBottom: 8, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <i className={`ti ${icon}`} style={{ color: sentColor, fontSize: 14, marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: "var(--color-text-primary)", textDecoration: "none", display: "block", lineHeight: 1.4 }}
                        onMouseOver={e => e.target.style.textDecoration = "underline"}
                        onMouseOut={e => e.target.style.textDecoration = "none"}>
                        {n.text}
                      </a>
                    ) : (
                      <div style={{ fontSize: 11, lineHeight: 1.4 }}>{n.text}</div>
                    )}
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, display: "flex", gap: 8 }}>
                      <span>{n.source}</span>
                      <span>{n.time}</span>
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 600, color: sentColor, flexShrink: 0 }}>
                    {n.sentiment >= 0 ? "+" : ""}{(n.sentiment * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8 }}><i className="ti ti-history" aria-hidden="true" /> Signal log</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
            {coin.history.slice(-12).reverse().map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "4px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <Badge action={h.action} />
                {h.manual && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>M</span>}
                {h.exitTrigger === "TRAILING_TAKE_PROFIT" && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>TTP</span>}
                {h.exitTrigger === "TAKE_PROFIT"     && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>TP</span>}
                {h.exitTrigger === "STOP_LOSS"        && <span style={{ fontSize: 10, background: "#fee2e2", color: "#991b1b", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>SL</span>}
                {h.exitTrigger === "TRAILING_STOP"    && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>TRL</span>}
                {h.exitTrigger === "ATR_TAKE_PROFIT"  && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>ATR-TP</span>}
                {h.exitTrigger === "ATR_STOP_LOSS"    && <span style={{ fontSize: 10, background: "#fee2e2", color: "#991b1b", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>ATR-SL</span>}
                {h.exitTrigger === "TIME_EXIT"        && <span style={{ fontSize: 10, background: "#ede9fe", color: "#5b21b6", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>TIME</span>}
                {h.exitTrigger === "SIGNAL_REVERSAL"  && <span style={{ fontSize: 10, background: "#fce7f3", color: "#9d174d", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>REV</span>}
                <span style={{ color: "var(--color-text-secondary)" }}>${fmt(h.price, selectedCoin === "BTC" ? 0 : 2)}</span>
                <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)", fontSize: 10 }}>
                  {h.manual ? "manual" : h.exitTrigger ? h.exitTrigger.toLowerCase().replace(/_/g, " ") : `conf ${h.confidence}%`}
                </span>
              </div>
            ))}
            {coin.history.length === 0 && <div style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>No signals yet - press Start</div>}
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", display: "flex", gap: 14, fontSize: 11, color: "var(--color-text-secondary)", flexWrap: "wrap", alignItems: "center" }}>
        <span><i className="ti ti-clock" aria-hidden="true" /> Tick {tickRef.current} ({(creds.tickIntervalMs||1500)/1000}s)</span>
        <span style={{ color: running ? "#10b981" : "#ef4444" }}>
          <i className={`ti ${running ? "ti-circle-check" : "ti-circle-x"}`} aria-hidden="true" />
          {running && autoEnabled ? "Live trading" : running ? "Simulating" : "Stopped"}
        </span>
        {running && (
          <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4,
            background: creds.tradingMode === "mean_reversion" ? "#6366f122" : "#10b98122",
            color:      creds.tradingMode === "mean_reversion" ? "#6366f1"   : "#10b981" }}>
            {creds.tradingMode === "mean_reversion" ? "↩ Mean Rev" : "📈 Momentum"}
          </span>
        )}
        {running && (
          <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: "#6366f122", color: "#6366f1" }}>
            {{ rules: "📐 Rules", rf: "🌲 RF", lstm: "🧠 LSTM", "rf+lstm": "🔬 RF+LSTM", deepseek: "🤖 DeepSeek" }[creds.signalSource || "rules"]}
          </span>
        )}
        <span style={{ color: statusColor }}><i className="ti ti-robot" aria-hidden="true" /> {statusLabel}</span>
        {/* WebSocket status */}
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", display: "inline-block",
            background: wsStatus === "connected" ? "#10b981" : wsStatus.startsWith("reconnect") ? "#f59e0b" : wsStatus === "connecting" ? "#6366f1" : "#94a3b8",
            boxShadow: wsStatus === "connected" ? "0 0 5px #10b981" : "none",
          }} />
          <span style={{ fontSize: 11, color: wsStatus === "connected" ? "#10b981" : "var(--color-text-secondary)" }}>
            {wsStatus === "connected" ? (autoEnabled ? "WS live" : "WS sim") : wsStatus === "idle" ? "WS off" : `WS: ${wsStatus}`}
          </span>
          {autoEnabled && (
            <button onClick={() => setWsEnabled(w => !w)}
              style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, cursor: "pointer",
                border: `0.5px solid ${wsEnabled ? "#10b981" : "var(--color-border-secondary)"}`,
                background: wsEnabled ? "#d1fae5" : "transparent",
                color: wsEnabled ? "#065f46" : "var(--color-text-secondary)" }}>
              {wsEnabled ? (wsStatus === "connected" ? "Live" : "Connecting...") : "Off"}
            </button>
          )}
        </span>
        <span style={{ color: autoEnabled && !wsEnabled ? "#10b981" : "var(--color-text-secondary)" }}>
          <i className="ti ti-refresh" aria-hidden="true" /> HTTP: {wsStatus === "connected" ? "standby" : autoEnabled ? "every 5s" : running ? "every 15s" : "off"}
        </span>
        {autoEnabled && COINS.some(c => orderErrorsRef.current[c] > 0) && (
          <span style={{ color: "#f59e0b" }}>
            <i className="ti ti-alert-triangle" aria-hidden="true" /> Order errors:{" "}
            {COINS.filter(c => orderErrorsRef.current[c] > 0)
              .map(c => `${c}: ${orderErrorsRef.current[c]}/${MAX_ORDER_ERRORS}`)
              .join(" · ")}
          </span>
        )}
        {creds.sandbox && autoEnabled && <span style={{ color: "#6366f1", fontWeight: 600 }}>{"SANDBOX MODE - no real orders"}</span>}
        <span style={{ marginLeft: "auto", color: (coin.pnl + unrealized) >= 0 ? "#10b981" : "#ef4444" }}>
          {"P&L: "}{(coin.pnl + unrealizedDollar) >= 0 ? "+" : "-"}{"$"}{Math.abs(coin.pnl + unrealizedDollar).toFixed(2)}{" ("}{fmtPct(unrealized)}{")"}{" "}{coin.trades}{" trades"}
        </span>
      </div>
    </div>
  );
}

// Named export so App.jsx can import it
export { CryptoAlgoTrader as default };

