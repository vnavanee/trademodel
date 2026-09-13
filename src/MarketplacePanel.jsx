import { useState, useEffect, useCallback } from "react";

const fmtDateTime = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

// ─── MarketplacePanel ──────────────────────────────────────────────────────────
// Full strategy marketplace: leaderboard, browse, publish, copy, rate.
// Kept in its own file — self-contained, no dependency on dashboard state
// beyond what is passed as props.
//
// Props:
//   PROXY_BASE    string   — Cloud Run proxy URL
//   creds         object   — current user's settings (for publish flow)
//   onCopy        fn       — called with sanitised settings when user copies a strategy
//   clerkUser     object   — Clerk user (null = not logged in)
//   onClose       fn       — close the panel

const SORT_OPTIONS = [
  { value: "total_pnl_pct",     label: "Best P&L %" },
  { value: "win_rate",          label: "Win rate" },
  { value: "subscriber_count",  label: "Most copied" },
  { value: "total_trades",      label: "Most active" },
  { value: "created_at",        label: "Newest" },
];

const COIN_COLORS = { BTC: "#f7931a", ETH: "#627eea", SOL: "#9945ff" };

const SOURCE_LABELS = {
  rules: "📐 Rules", rf: "🌲 RF", lstm: "🧠 LSTM",
  "rf+lstm": "🔬 RF+LSTM", rl: "🎮 RL", deepseek: "🤖 AI",
};

function Stars({ value, count, onRate }) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {[1,2,3,4,5].map(n => (
        <span key={n}
          onClick={() => onRate && onRate(n)}
          onMouseEnter={() => onRate && setHover(n)}
          onMouseLeave={() => onRate && setHover(0)}
          style={{
            fontSize: 14, cursor: onRate ? "pointer" : "default",
            color: n <= (hover || Math.round(value || 0)) ? "#f59e0b" : "var(--color-border-secondary)",
            transition: "color 0.1s",
          }}>★</span>
      ))}
      {count > 0 && (
        <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginLeft: 2 }}>
          {parseFloat(value).toFixed(1)} ({count})
        </span>
      )}
    </div>
  );
}

function MetricBadge({ label, value, color }) {
  return (
    <div style={{ textAlign: "center", minWidth: 64 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: color || "var(--color-text-primary, #f1f5f9)" }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 1, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
    </div>
  );
}

function StrategyCard({ strategy, onView, onCopy, onRate, myUserId, compact }) {
  const pnl       = parseFloat(strategy.total_pnl_pct || 0);
  const winRate   = parseFloat(strategy.win_rate || 0);
  const drawdown  = parseFloat(strategy.max_drawdown || 0);
  const isOwn     = strategy.user_id === myUserId;

  return (
    <div style={{
      background: "var(--color-background-secondary, #1e2128)",
      border: "0.5px solid var(--color-border-tertiary, #2a2d36)",
      borderRadius: 10, overflow: "hidden",
      transition: "border-color 0.15s",
    }}>
      {/* Header row */}
      <div style={{ padding: compact ? "10px 14px" : "12px 16px",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            {strategy.rank && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#6366f1",
                background: "#6366f114", padding: "1px 6px", borderRadius: 4 }}>
                #{strategy.rank}
              </span>
            )}
            <span style={{ fontSize: 13, fontWeight: 700,
              color: "var(--color-text-primary, #f1f5f9)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {strategy.name}
            </span>
            {isOwn && (
              <span style={{ fontSize: 9, color: "#10b981", background: "#10b98118",
                padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>yours</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
              {SOURCE_LABELS[strategy.signal_source] || strategy.signal_source}
            </span>
            <span style={{ color: "var(--color-border-secondary)", fontSize: 10 }}>·</span>
            {(strategy.coins || []).map(c => (
              <span key={c} style={{ fontSize: 9, fontWeight: 700,
                color: COIN_COLORS[c] || "var(--color-text-secondary)",
                background: (COIN_COLORS[c] || "var(--color-text-secondary)") + "18",
                padding: "1px 5px", borderRadius: 3 }}>{c}</span>
            ))}
            {(strategy.tags || []).map(t => (
              <span key={t} style={{ fontSize: 9, color: "var(--color-text-tertiary)",
                background: "var(--color-background-secondary)", padding: "1px 5px", borderRadius: 3 }}>#{t}</span>
            ))}
          </div>
          {strategy.description && !compact && (
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 5, lineHeight: 1.5,
              display: "-webkit-box", WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {strategy.description}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          {onView && (
            <button onClick={() => onView(strategy)}
              style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11,
                border: "0.5px solid var(--color-border-secondary, #374151)",
                background: "transparent", color: "var(--color-text-secondary)",
                cursor: "pointer", fontFamily: "inherit" }}>
              Details
            </button>
          )}
          {onCopy && (
            <button onClick={() => onCopy(strategy)}
              style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: "none", background: "#6366f1", color: "#fff",
                cursor: "pointer", fontFamily: "inherit" }}>
              Copy
            </button>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div style={{ padding: "0 16px 12px",
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        <MetricBadge label="P&L"
          value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`}
          color={pnl >= 0 ? "#10b981" : "#ef4444"} />
        <MetricBadge label="Win rate"
          value={`${winRate.toFixed(0)}%`}
          color={winRate >= 50 ? "#10b981" : "#f59e0b"} />
        <MetricBadge label="Trades"
          value={strategy.total_trades || 0} />
        <MetricBadge label="Copied"
          value={strategy.subscriber_count || 0} />
      </div>

      {/* Rating + drawdown row */}
      <div style={{ padding: "8px 16px", borderTop: "0.5px solid var(--color-border-tertiary, #2a2d36)",
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Stars value={strategy.avgStars} count={strategy.ratingCount || 0}
          onRate={onRate} />
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {drawdown > 0 && (
            <span style={{ fontSize: 10, color: "#ef4444" }}>
              ↓ {drawdown.toFixed(1)}% max dd
            </span>
          )}
          <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
            {fmtDateTime(new Date(strategy.created_at))}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Publish flow ─────────────────────────────────────────────────────────────
function PublishForm({ creds, proxyBase, clerkUser, onPublished, onCancel }) {
  const [name,    setName]    = useState("");
  const [desc,    setDesc]    = useState("");
  const [tags,    setTags]    = useState("");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");

  // Preview what will be stripped
  const STRIPPED = ["keys", "apiKey", "apiSecret", "apiPassphrase", "tradeSizeUSD", "balanceBuffer"];
  const willShare = Object.keys(creds || {})
    .filter(k => !STRIPPED.includes(k))
    .reduce((o, k) => ({ ...o, [k]: creds[k] }), {});

  const publish = async () => {
    if (!name.trim()) { setError("Please give your strategy a name"); return; }
    setSaving(true); setError("");
    try {
      const token = await window.Clerk?.session?.getToken();
      if (!token) throw new Error("Please sign in to publish");
      const res = await fetch(`${proxyBase}/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim(),
          tags: tags.split(",").map(t => t.trim()).filter(Boolean),
          creds: willShare,
          coins: creds.enabledCoins || ["BTC"],
          signalSource: creds.signalSource || "rules",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      onPublished(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-primary, #f1f5f9)", marginBottom: 4 }}>
        Share your strategy
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 16, lineHeight: 1.5 }}>
        Your API keys and trade size are never shared. Only your signal configuration,
        exit rules, and indicator settings will be visible to other users.
      </div>

      <label style={{ display: "block", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 5 }}>
          Strategy name
        </div>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. BTC RSI Scalper, ETH RL Trend Follower"
          maxLength={80}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px",
            borderRadius: 7, fontSize: 13, fontFamily: "inherit",
            border: "0.5px solid var(--color-border-secondary, #374151)",
            background: "var(--color-background-primary, #12151a)",
            color: "var(--color-text-primary, #f1f5f9)" }} />
      </label>

      <label style={{ display: "block", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 5 }}>
          Description <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>(optional)</span>
        </div>
        <textarea value={desc} onChange={e => setDesc(e.target.value)}
          placeholder="How does this strategy work? What market conditions suit it?"
          rows={3} maxLength={500}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px",
            borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical",
            border: "0.5px solid var(--color-border-secondary, #374151)",
            background: "var(--color-background-primary, #12151a)",
            color: "var(--color-text-primary, #f1f5f9)" }} />
      </label>

      <label style={{ display: "block", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 5 }}>
          Tags <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>(comma-separated)</span>
        </div>
        <input value={tags} onChange={e => setTags(e.target.value)}
          placeholder="btc, scalping, rl, low-risk"
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px",
            borderRadius: 7, fontSize: 12, fontFamily: "inherit",
            border: "0.5px solid var(--color-border-secondary, #374151)",
            background: "var(--color-background-primary, #12151a)",
            color: "var(--color-text-primary, #f1f5f9)" }} />
      </label>

      {/* Preview of what gets shared */}
      <div style={{ padding: "10px 12px", borderRadius: 8, marginBottom: 16,
        background: "var(--color-background-primary)", border: "0.5px solid #1e293b", fontSize: 11 }}>
        <div style={{ fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>
          What gets shared:
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {Object.keys(willShare).map(k => (
            <span key={k} style={{ padding: "2px 6px", borderRadius: 4,
              background: "var(--color-border-tertiary)", color: "var(--color-text-tertiary)", fontSize: 10 }}>
              {k}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 8, color: "var(--color-text-tertiary)", fontSize: 10 }}>
          ✓ API keys — never shared &nbsp;
          ✓ Trade size — each user sets their own
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 10px", borderRadius: 6, marginBottom: 12,
          background: "#ef444411", border: "0.5px solid #ef444433",
          color: "#ef4444", fontSize: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel}
          style={{ flex: 1, padding: "9px 0", borderRadius: 7, fontSize: 12,
            border: "0.5px solid var(--color-border-secondary, #374151)",
            background: "transparent", color: "var(--color-text-secondary)",
            cursor: "pointer", fontFamily: "inherit" }}>
          Cancel
        </button>
        <button onClick={publish} disabled={saving}
          style={{ flex: 2, padding: "9px 0", borderRadius: 7, fontSize: 12, fontWeight: 700,
            border: "none", background: saving ? "#6366f166" : "#6366f1",
            color: "#fff", cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}>
          {saving ? "Publishing…" : "Publish strategy"}
        </button>
      </div>
    </div>
  );
}

// ─── Detail drawer ────────────────────────────────────────────────────────────
function StrategyDetail({ strategy, proxyBase, clerkUser, myUserId, onCopy, onClose }) {
  const [rating, setRating]   = useState(null); // user's own pending rating
  const [review, setReview]   = useState("");
  const [saving, setSaving]   = useState(false);
  const [msg,    setMsg]      = useState("");

  const submitRating = async (stars) => {
    setRating(stars);
    if (!clerkUser) { setMsg("Sign in to rate strategies"); return; }
    setSaving(true);
    try {
      const token = await window.Clerk?.session?.getToken();
      const res = await fetch(`${proxyBase}/strategies/${strategy.strategy_id}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stars, review }),
      });
      if (res.ok) setMsg("Rating saved ✓");
      else setMsg("Failed to save rating");
    } catch { setMsg("Failed to save rating"); }
    finally { setSaving(false); }
  };

  const pnl = parseFloat(strategy.total_pnl_pct || 0);
  const reviews = (strategy.strategy_ratings || []).filter(r => r.review);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--color-border-tertiary, #2a2d36)",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-primary, #f1f5f9)" }}>
            {strategy.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            {SOURCE_LABELS[strategy.signal_source]} · {(strategy.coins || []).join(", ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => onCopy(strategy)}
            style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 700,
              border: "none", background: "#6366f1", color: "#fff",
              cursor: "pointer", fontFamily: "inherit" }}>
            Copy strategy
          </button>
          <button onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: "50%", border: "none",
              background: "var(--color-background-secondary, #1e2128)",
              color: "var(--color-text-tertiary)", fontSize: 16,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <MetricBadge label="P&L" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`}
            color={pnl >= 0 ? "#10b981" : "#ef4444"} />
          <MetricBadge label="Win rate" value={`${parseFloat(strategy.win_rate || 0).toFixed(0)}%`} />
          <MetricBadge label="Trades" value={strategy.total_trades || 0} />
          <MetricBadge label="Copied by" value={strategy.subscriber_count || 0} />
        </div>

        {strategy.description && (
          <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 8,
            background: "var(--color-background-secondary, #1e2128)",
            fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {strategy.description}
          </div>
        )}

        {/* Settings preview */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 8 }}>
            Strategy settings
          </div>
          <div style={{ padding: "12px 14px", borderRadius: 8,
            background: "var(--color-background-secondary, #1e2128)",
            border: "0.5px solid var(--color-border-tertiary, #2a2d36)",
            fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.9 }}>
            <div>Signal: <strong style={{ color: "var(--color-text-secondary)" }}>
              {SOURCE_LABELS[strategy.signal_source]}
            </strong></div>
            <div>Coins: <strong style={{ color: "var(--color-text-secondary)" }}>
              {(strategy.coins || []).join(", ")}
            </strong></div>
            {strategy.settings?.minConfidence && (
              <div>Min confidence: <strong style={{ color: "var(--color-text-secondary)" }}>
                {strategy.settings.minConfidence}%
              </strong></div>
            )}
            {strategy.settings?.cooldownMinutes && (
              <div>Cooldown: <strong style={{ color: "var(--color-text-secondary)" }}>
                {strategy.settings.cooldownMinutes}min
              </strong></div>
            )}
            {strategy.settings?.rlParams && (
              <div>RL α={strategy.settings.rlParams.alpha} γ={strategy.settings.rlParams.gamma}</div>
            )}
          </div>
        </div>

        {/* Rate this strategy */}
        {strategy.user_id !== myUserId && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 8 }}>
              Rate this strategy
            </div>
            <Stars value={rating || strategy.avgStars} count={0} onRate={submitRating} />
            <textarea value={review} onChange={e => setReview(e.target.value)}
              placeholder="Leave a review (optional)"
              rows={2} maxLength={500}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 8,
                padding: "7px 10px", borderRadius: 7, fontSize: 11, resize: "vertical",
                fontFamily: "inherit",
                border: "0.5px solid var(--color-border-secondary, #374151)",
                background: "var(--color-background-primary, #12151a)",
                color: "var(--color-text-primary, #f1f5f9)" }} />
            {msg && <div style={{ fontSize: 11, color: "#10b981", marginTop: 4 }}>{msg}</div>}
          </div>
        )}

        {/* Reviews */}
        {reviews.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 8 }}>
              Reviews
            </div>
            {reviews.map(r => (
              <div key={r.user_id} style={{ padding: "8px 12px", borderRadius: 7, marginBottom: 6,
                background: "var(--color-background-secondary, #1e2128)" }}>
                <Stars value={r.stars} count={0} />
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4, lineHeight: 1.5 }}>
                  {r.review}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export default function MarketplacePanel({ PROXY_BASE, creds, onCopy, clerkUser, onClose, theme = "dark" }) {
  const [view,        setView]       = useState("leaderboard"); // "leaderboard"|"browse"|"publish"|"mine"
  const [strategies,  setStrategies] = useState([]);
  const [leaderboard, setLeaderboard]= useState([]);
  const [sort,        setSort]       = useState("total_pnl_pct");
  const [coinFilter,  setCoinFilter] = useState("");
  const [loading,     setLoading]    = useState(false);
  const [detail,      setDetail]     = useState(null);  // strategy being viewed
  const [showPublish, setShowPublish]= useState(false);
  const [copyMsg,     setCopyMsg]    = useState("");
  const [error,       setError]      = useState("");

  const myUserId = clerkUser?.id;

  const apiFetch = useCallback(async (path, opts = {}) => {
    const token = await window.Clerk?.session?.getToken().catch(() => null);
    return fetch(`${PROXY_BASE}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
    });
  }, [PROXY_BASE]);

  const loadLeaderboard = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res  = await apiFetch(`/leaderboard?sort=${sort}&limit=25`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setLeaderboard(data.leaderboard || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [sort, apiFetch]);

  const loadStrategies = useCallback(async (mine = false) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ sort, limit: "20" });
    if (coinFilter) params.set("coin", coinFilter);
    if (mine)       params.set("mine", "1");
    try {
      const res  = await apiFetch(`/strategies?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setStrategies(data.strategies || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [sort, coinFilter, apiFetch]);

  useEffect(() => {
    if (view === "leaderboard") loadLeaderboard();
    else if (view === "browse") loadStrategies(false);
    else if (view === "mine")   loadStrategies(true);
  }, [view, sort, coinFilter]);

  const handleCopy = async (strategy) => {
    if (!clerkUser) { setCopyMsg("Sign in to copy strategies"); return; }
    try {
      const res  = await apiFetch(`/strategies/${strategy.strategy_id}/copy`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Copy failed");
      // Call parent with the sanitised settings
      onCopy({ settings: data.settings, coins: data.coins, signalSource: data.signalSource });
      setCopyMsg(`✓ "${strategy.name}" settings copied — open Settings to review before running`);
      setTimeout(() => setCopyMsg(""), 6000);
      setDetail(null);
    } catch (e) {
      setCopyMsg(`✗ ${e.message}`);
      setTimeout(() => setCopyMsg(""), 4000);
    }
  };

  const displayList = view === "leaderboard" ? leaderboard : strategies;

  return (
    <div style={{ display: "flex", height: "100%", fontFamily: "inherit" }}>
      {/* Main panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <div style={{ padding: "18px 20px 14px",
          borderBottom: "0.5px solid var(--color-border-tertiary, #2a2d36)",
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-text-primary, #f1f5f9)" }}>
              Strategy Marketplace
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
              Browse and copy strategies from the community
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {clerkUser && (
              <button onClick={() => setShowPublish(true)}
                style={{ padding: "6px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                  border: "0.5px solid #6366f166", background: "#6366f111",
                  color: "#6366f1", cursor: "pointer", fontFamily: "inherit" }}>
                + Share mine
              </button>
            )}
            <button onClick={onClose}
              style={{ width: 28, height: 28, borderRadius: "50%", border: "none",
                background: "var(--color-background-secondary, #1e2128)",
                color: "var(--color-text-tertiary)", fontSize: 16, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 2, padding: "8px 20px",
          borderBottom: "0.5px solid var(--color-border-tertiary, #2a2d36)",
          background: "var(--color-background-secondary, #1e2128)" }}>
          {[
            { id: "leaderboard", label: "🏆 Leaderboard" },
            { id: "browse",      label: "🔍 Browse" },
            ...(clerkUser ? [{ id: "mine", label: "📁 My strategies" }] : []),
          ].map(t => (
            <button key={t.id} onClick={() => setView(t.id)}
              style={{ padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: "none", cursor: "pointer", fontFamily: "inherit",
                background: view === t.id ? "#6366f1" : "transparent",
                color: view === t.id ? "#fff" : "var(--color-text-tertiary)" }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Sort + filter controls */}
        <div style={{ display: "flex", gap: 8, padding: "10px 20px",
          alignItems: "center", borderBottom: "0.5px solid var(--color-border-tertiary, #2a2d36)" }}>
          <select value={sort} onChange={e => setSort(e.target.value)}
            style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6,
              border: "0.5px solid var(--color-border-secondary, #374151)",
              background: "var(--color-background-secondary, #1e2128)",
              color: "var(--color-text-secondary)", fontFamily: "inherit", cursor: "pointer" }}>
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {view === "browse" && (
            <select value={coinFilter} onChange={e => setCoinFilter(e.target.value)}
              style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6,
                border: "0.5px solid var(--color-border-secondary, #374151)",
                background: "var(--color-background-secondary, #1e2128)",
                color: "var(--color-text-secondary)", fontFamily: "inherit", cursor: "pointer" }}>
              <option value="">All coins</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
            </select>
          )}
          <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-tertiary)" }}>
            {displayList.length} {displayList.length === 1 ? "strategy" : "strategies"}
          </div>
        </div>

        {/* Copy feedback */}
        {copyMsg && (
          <div style={{ margin: "8px 20px 0", padding: "8px 12px", borderRadius: 7, fontSize: 12,
            background: copyMsg.startsWith("✓") ? "#10b98111" : "#ef444411",
            border: `0.5px solid ${copyMsg.startsWith("✓") ? "#10b98133" : "#ef444433"}`,
            color: copyMsg.startsWith("✓") ? "#10b981" : "#ef4444" }}>
            {copyMsg}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
          {loading && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-tertiary)", fontSize: 13 }}>
              Loading…
            </div>
          )}
          {!loading && error && (
            <div style={{ textAlign: "center", padding: "40px 20px",
              color: "#ef4444", fontSize: 13 }}>
              {error}
              <br /><button onClick={() => view === "leaderboard" ? loadLeaderboard() : loadStrategies(view === "mine")}
                style={{ marginTop: 10, padding: "5px 12px", borderRadius: 6,
                  border: "0.5px solid #ef444466", background: "transparent",
                  color: "#ef4444", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && displayList.length === 0 && (
            <div style={{ textAlign: "center", padding: "48px 20px" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>
                {view === "mine" ? "📁" : "🌐"}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                {view === "mine"
                  ? "You haven't shared any strategies yet"
                  : "No strategies found"}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.6 }}>
                {view === "mine"
                  ? "Click \"+ Share mine\" to publish your current settings so others can copy them."
                  : "Be the first to share a strategy."}
              </div>
            </div>
          )}
          {!loading && !error && displayList.map(strategy => (
            <div key={strategy.strategy_id} style={{ marginBottom: 10 }}>
              <StrategyCard
                strategy={strategy}
                myUserId={myUserId}
                onView={s => setDetail(s)}
                onCopy={handleCopy}
                compact={view === "leaderboard"}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Detail drawer */}
      {detail && !showPublish && (
        <div style={{ width: 360, flexShrink: 0,
          borderLeft: "0.5px solid var(--color-border-tertiary, #2a2d36)",
          background: "var(--color-background-primary, #12151a)",
          display: "flex", flexDirection: "column" }}>
          <StrategyDetail
            strategy={detail}
            proxyBase={PROXY_BASE}
            clerkUser={clerkUser}
            myUserId={myUserId}
            onCopy={handleCopy}
            onClose={() => setDetail(null)}
          />
        </div>
      )}

      {/* Publish drawer */}
      {showPublish && (
        <div style={{ width: 400, flexShrink: 0,
          borderLeft: "0.5px solid var(--color-border-tertiary, #2a2d36)",
          background: "var(--color-background-primary, #12151a)",
          overflowY: "auto" }}>
          <PublishForm
            creds={creds}
            proxyBase={PROXY_BASE}
            clerkUser={clerkUser}
            onPublished={(data) => {
              setShowPublish(false);
              setCopyMsg(`✓ "${data.name}" published to the marketplace`);
              if (view === "mine") loadStrategies(true);
            }}
            onCancel={() => setShowPublish(false)}
          />
        </div>
      )}
    </div>
  );
}
