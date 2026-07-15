// ============================================================
// SETTINGS PERSISTENCE — usePersistedSettings hook
// ============================================================
// Drop this into crypto_algo_trader.jsx (or a separate file).
// Replace the existing useState for `creds` with this hook.
//
// What it does:
//   1. On mount: loads saved creds from the database via GET /settings
//   2. On every creds change (debounced 2s): saves to database via PUT /settings
//   3. On every completed trade: persists the transaction via POST /transactions
//   4. Handles auth token injection on all proxy calls
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";

const SAVE_DEBOUNCE_MS = 2000; // wait 2s after last change before saving

// ─── usePersistedSettings ─────────────────────────────────────────────────────
export function usePersistedSettings(PROXY_BASE, defaultCreds) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [creds, setCredsState]  = useState(defaultCreds);
  const [loadState, setLoadState] = useState("idle"); // idle|loading|ready|error
  const [saveState, setSaveState] = useState("idle"); // idle|saving|saved|error
  const saveTimerRef = useRef(null);
  const lastSavedRef = useRef(null);

  // Helper: authenticated fetch
  const authFetch = useCallback(async (url, opts = {}) => {
    const token = await getToken();
    return fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...opts.headers,
      },
    });
  }, [getToken]);

  // ── Load settings on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !PROXY_BASE) return;

    const load = async () => {
      setLoadState("loading");
      try {
        const res  = await authFetch(`${PROXY_BASE}/settings`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        if (data.creds) {
          // Merge saved creds with defaults so new fields added in app updates
          // don't disappear for existing users
          setCredsState(prev => ({ ...prev, ...data.creds }));
          lastSavedRef.current = JSON.stringify(data.creds);
          console.log("[settings] loaded from DB, plan:", data.plan);
        } else {
          console.log("[settings] no saved settings — using defaults");
        }
        setLoadState("ready");
      } catch (e) {
        console.error("[settings] load failed:", e.message);
        setLoadState("error");
        // Fall back to defaults — app still works
      }
    };

    load();
  }, [isLoaded, isSignedIn, PROXY_BASE]);

  // ── Debounced save on creds change ────────────────────────────────────────
  const setCreds = useCallback((newCredsOrFn) => {
    setCredsState(prev => {
      const next = typeof newCredsOrFn === "function" ? newCredsOrFn(prev) : newCredsOrFn;

      // Skip save if nothing actually changed
      const nextStr = JSON.stringify(next);
      if (nextStr === lastSavedRef.current) return next;

      // Debounce: clear previous timer, start new one
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        setSaveState("saving");
        try {
          const res = await authFetch(`${PROXY_BASE}/settings`, {
            method: "PUT",
            body:   JSON.stringify({ creds: next }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          lastSavedRef.current = nextStr;
          setSaveState("saved");
          setTimeout(() => setSaveState("idle"), 2000);
          console.log("[settings] saved to DB");
        } catch (e) {
          console.error("[settings] save failed:", e.message);
          setSaveState("error");
          setTimeout(() => setSaveState("idle"), 4000);
        }
      }, SAVE_DEBOUNCE_MS);

      return next;
    });
  }, [authFetch, PROXY_BASE]);

  return { creds, setCreds, loadState, saveState };
}

// ─── useTransactionLogger ─────────────────────────────────────────────────────
// Wraps the existing logTransaction to also persist to the database.
export function useTransactionLogger(PROXY_BASE) {
  const { getToken } = useAuth();

  const logTransaction = useCallback(async (entry) => {
    // Still write to local txLog state (the caller handles that)
    // Also persist to DB asynchronously — fire and forget
    try {
      const token = await getToken();
      fetch(`${PROXY_BASE}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type:           entry.type,
          coin:           entry.coin,
          price:          entry.price,
          qty:            entry.qty,
          usdValue:       entry.usdValue,
          pnl:            entry.pnl,
          fees:           entry.fees,
          netPnl:         entry.netPnl,
          exitReason:     entry.exitReason,
          agentReasoning: entry.agentReason,
          lstmTrend:      entry.lstmTrend   ? parseFloat(entry.lstmTrend)   : null,
          lstmChangePct:  entry.lstmChange  ? parseFloat(entry.lstmChange)  : null,
          lstmVol:        entry.lstmVol     ? parseFloat(entry.lstmVol)     : null,
          rfDirProb:      entry.rfDirProb   || null,
          signalSource:   entry.signalSource || null,
          mode:           entry.mode,
          timestamp:      entry.timestamp,
        }),
      }).catch(e => console.warn("[tx] DB persist failed:", e.message));
    } catch (e) {
      console.warn("[tx] logger error:", e.message);
    }
  }, [getToken, PROXY_BASE]);

  return { logTransaction };
}

// ─── useLoadTransactions ──────────────────────────────────────────────────────
// Load full transaction history from the database (e.g. for analytics page).
export function useLoadTransactions(PROXY_BASE) {
  const { getToken, isSignedIn } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async ({ coin, mode, limit = 100, offset = 0 } = {}) => {
    if (!isSignedIn) return;
    setLoading(true);
    try {
      const token  = await getToken();
      const params = new URLSearchParams({ limit, offset });
      if (coin) params.set("coin", coin);
      if (mode) params.set("mode", mode);
      const res  = await fetch(`${PROXY_BASE}/transactions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setTransactions(data.transactions || []);
      return data;
    } catch (e) {
      console.error("[tx] load failed:", e.message);
    } finally {
      setLoading(false);
    }
  }, [getToken, isSignedIn, PROXY_BASE]);

  return { transactions, loading, load };
}

// ─── SaveIndicator component ──────────────────────────────────────────────────
// Show in the UI so users know their settings are being saved.
// Usage: <SaveIndicator state={saveState} />
export function SaveIndicator({ state }) {
  if (state === "idle") return null;
  const config = {
    saving: { color: "#f59e0b", text: "Saving..." },
    saved:  { color: "#10b981", text: "✓ Saved"  },
    error:  { color: "#ef4444", text: "Save failed — check connection" },
  };
  const c = config[state];
  if (!c) return null;
  return (
    <span style={{ fontSize: 11, color: c.color, padding: "2px 8px",
      borderRadius: 4, background: c.color + "15" }}>
      {c.text}
    </span>
  );
}

// ─── HOW TO INTEGRATE ─────────────────────────────────────────────────────────
//
// In crypto_algo_trader.jsx, replace:
//
//   const [creds, setCreds] = useState({ ... defaultCreds ... });
//
// With:
//
//   import { usePersistedSettings, SaveIndicator } from "./settings_persistence";
//
//   const { creds, setCreds, loadState, saveState } =
//     usePersistedSettings(PROXY_BASE, defaultCredsObject);
//
//   // Show loading state while settings are fetched on login
//   if (loadState === "loading") return <div>Loading your settings...</div>;
//
//   // Show save indicator in the header or settings modal
//   <SaveIndicator state={saveState} />
//
// The hook is a drop-in replacement — setCreds has the same signature as
// the useState setter (accepts value or updater function), so all existing
// code that calls setCreds(...) works unchanged.
//
// For transaction persistence, in the logTransaction callback, also call:
//
//   const { logTransaction: persistTx } = useTransactionLogger(PROXY_BASE);
//
//   // Inside logTransaction:
//   const entry = { id, timestamp, ... };
//   setTxLog(prev => [entry, ...prev].slice(0, 1000));
//   persistTx(entry); // fire-and-forget DB write
