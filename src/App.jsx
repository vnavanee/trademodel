import React, { useState } from "react";
import { SignedIn, SignedOut, useUser } from "@clerk/clerk-react";
import { AuthScreen } from "./clerk_integration";
import CryptoAlgoTrader from "./crypto_algo_trader";

const PROXY_BASE = import.meta.env.VITE_PROXY_BASE
  || "https://coinbaseticker-283150216453.europe-west1.run.app";

// ─── PlanSelector ─────────────────────────────────────────────────────────────
// Shown once to new users (no plan set in Clerk metadata yet).
// They can pick a paid plan (Stripe Checkout) or continue free.
function PlanSelector() {
  const [loading, setLoading] = useState(null);
  const [error,   setError]   = useState(null);
  // dismissed = true means user chose Free and we show the dashboard
  const [dismissed, setDismissed] = useState(false);

  const { user } = useUser();

  const choosePlan = async (plan) => {
    if (plan === "free") {
      // Skip Stripe — just go straight to the dashboard with Free restrictions.
      // plan in Clerk metadata will be set by the user.created webhook soon.
      // In the meantime AuthenticatedApp checks dismissed state.
      setDismissed(true);
      return;
    }
    setLoading(plan);
    setError(null);
    try {
      // Get JWT via Clerk global (safe to use outside hooks in event handlers)
      const token = await window.Clerk?.session?.getToken();
      if (!token) throw new Error("Not signed in — please refresh and try again");
      const res = await fetch(`${PROXY_BASE}/subscribe`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          plan,
          successUrl: window.location.origin + "/?upgraded=1",
          cancelUrl:  window.location.origin + "/",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status}) — check Cloud Run is deployed with auth middleware`);
      if (!data.url) throw new Error("No Stripe checkout URL returned — check STRIPE_SECRET_KEY and STRIPE_PRICE_PRO env vars on Cloud Run");
      window.location.href = data.url;
    } catch (e) {
      setError(e.message);
      setLoading(null);
    }
  };

  // User chose Free — render the dashboard directly
  if (dismissed) return <CryptoAlgoTrader />;

  const plans = [
    {
      id:       "free",
      label:    "Free",
      price:    "$0",
      color:    "#94a3b8",
      features: ["Simulation only", "BTC only", "Rule-based signals", "Transaction export"],
      cta:      "Start free",
    },
    {
      id:       "pro",
      label:    "Pro",
      price:    "$29/mo",
      color:    "#6366f1",
      badge:    "Most popular",
      features: ["Live trading", "Up to 10 coins", "RF + LSTM models", "Full transaction history"],
      cta:      "Start Pro",
    },
    {
      id:       "pro_ai",
      label:    "Pro AI",
      price:    "$49/mo",
      color:    "#10b981",
      features: ["Everything in Pro", "DeepSeek AI agent", "Adaptive TP/SL", "Up to 50 coins"],
      cta:      "Start Pro AI",
    },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f1117 0%, #1a1f2e 100%)",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif",
      padding: "32px 16px", gap: 32,
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>₿</div>
        <h1 style={{ color: "#e8eaf0", fontSize: 24, fontWeight: 800, margin: 0 }}>
          Choose your plan
        </h1>
        <p style={{ color: "#555b73", fontSize: 14, marginTop: 8 }}>
          You can upgrade or downgrade anytime.
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center", maxWidth: 860 }}>
        {plans.map(p => (
          <div key={p.id} style={{
            background: "#1a1f2e", borderRadius: 12, padding: "28px 24px",
            border: `1.5px solid ${p.color}44`, flex: 1, minWidth: 220, maxWidth: 260,
            display: "flex", flexDirection: "column", gap: 16, position: "relative",
          }}>
            {p.badge && (
              <div style={{
                position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                background: p.color, color: "#fff", fontSize: 10, fontWeight: 700,
                padding: "3px 12px", borderRadius: 20, letterSpacing: 0.5,
                textTransform: "uppercase", whiteSpace: "nowrap",
              }}>{p.badge}</div>
            )}
            <div>
              <div style={{ color: p.color, fontSize: 12, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                {p.label}
              </div>
              <div style={{ color: "#e8eaf0", fontSize: 28, fontWeight: 800 }}>{p.price}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              {p.features.map(f => (
                <div key={f} style={{ color: "#8b92a9", fontSize: 13, display: "flex", gap: 8 }}>
                  <span style={{ color: p.color, flexShrink: 0 }}>✓</span> {f}
                </div>
              ))}
            </div>
            <button
              onClick={() => choosePlan(p.id)}
              disabled={!!loading}
              style={{
                padding: "10px 0", borderRadius: 8, border: "none",
                background: loading === p.id ? p.color + "66" : p.color,
                color: p.id === "free" ? "#1a1f2e" : "#fff",
                fontWeight: 700, fontSize: 14, cursor: loading ? "wait" : "pointer",
                fontFamily: "inherit", width: "100%", transition: "opacity 0.15s",
                opacity: loading && loading !== p.id ? 0.5 : 1,
              }}
            >
              {loading === p.id ? "Loading..." : p.cta}
            </button>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ color: "#ef4444", fontSize: 13, background: "#fee2e222",
          padding: "8px 16px", borderRadius: 8, border: "0.5px solid #ef4444" }}>
          {error}
        </div>
      )}

      <p style={{ color: "#555b73", fontSize: 12 }}>
        No credit card required for the free plan. Cancel paid plans anytime.
      </p>
    </div>
  );
}

// ─── AuthenticatedApp ─────────────────────────────────────────────────────────
function AuthenticatedApp() {
  const { user, isLoaded } = useUser();

  if (!isLoaded) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f1117", display: "flex",
        alignItems: "center", justifyContent: "center", color: "#555b73", fontSize: 14 }}>
        Loading...
      </div>
    );
  }

  const plan = user?.publicMetadata?.plan;

  // ?upgraded=1 means user just returned from Stripe Checkout — go straight to dashboard
  // The Stripe webhook fires async so metadata may not be updated yet; dashboard
  // will show the correct plan once Clerk refreshes (usually within a few seconds)
  const justUpgraded = new URLSearchParams(window.location.search).get("upgraded") === "1";
  if (justUpgraded) {
    // Clean up the URL without reloading
    window.history.replaceState({}, "", window.location.pathname);
    return <CryptoAlgoTrader />;
  }

  // Show plan selector if brand new user (no plan in Clerk metadata yet)
  if (!plan) {
    return <PlanSelector />;
  }

  return <CryptoAlgoTrader />;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <>
      <SignedOut>
        <AuthScreen />
      </SignedOut>
      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
    </>
  );
}
