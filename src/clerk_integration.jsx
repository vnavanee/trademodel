import React, { useState } from "react";
import { SignIn, useAuth, useUser } from "@clerk/clerk-react";

// ─── AuthScreen ───────────────────────────────────────────────────────────────
// Shown to unauthenticated users. Renders the Clerk sign-in widget
// inside a branded landing page with a pricing overview.
export function AuthScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f1117 0%, #1a1f2e 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Inter', system-ui, sans-serif",
        gap: 32,
        padding: "32px 16px",
      }}
    >
      {/* Logo */}
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>₿</div>
        <h1
          style={{
            color: "#e8eaf0",
            fontSize: 26,
            fontWeight: 800,
            margin: 0,
            letterSpacing: -0.5,
          }}
        >
          Algo Trader
        </h1>
        <p style={{ color: "#555b73", fontSize: 14, marginTop: 6, marginBottom: 0 }}>
          AI-powered crypto trading automation
        </p>
      </div>

      {/* Clerk sign-in widget */}
      <SignIn
        appearance={{
          variables: {
            colorPrimary:          "#6366f1",
            colorBackground:       "#1a1f2e",
            colorInputBackground:  "#0f1117",
            colorText:             "#e8eaf0",
            colorTextSecondary:    "#8b92a9",
            colorInputText:        "#e8eaf0",
            borderRadius:          "8px",
            fontFamily:            "Inter, system-ui, sans-serif",
          },
          elements: {
            card: {
              boxShadow: "0 0 48px rgba(99,102,241,0.15)",
              border:    "0.5px solid #2d3353",
              background: "#1a1f2e",
            },
            headerTitle:    { color: "#e8eaf0", fontWeight: 700 },
            headerSubtitle: { color: "#555b73" },
            formButtonPrimary: {
              background:  "#6366f1",
              fontWeight:  700,
            },
            footerActionLink: { color: "#6366f1" },
          },
        }}
        redirectUrl="/"
      />

      {/* Pricing tiers */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 640,
        }}
      >
        {[
          {
            plan:     "Free",
            price:    "$0",
            color:    "#555b73",
            features: ["Simulation only", "BTC only", "Rule-based signals"],
          },
          {
            plan:     "Pro",
            price:    "$29/mo",
            color:    "#6366f1",
            features: ["Live trading", "10 coins", "RF + LSTM models"],
          },
          {
            plan:     "Pro AI",
            price:    "$49/mo",
            color:    "#10b981",
            features: ["All coins", "DeepSeek agent", "Adaptive TP/SL"],
          },
        ].map((t) => (
          <div
            key={t.plan}
            style={{
              background:   "#1a1f2e",
              border:       `0.5px solid ${t.color}44`,
              borderRadius: 10,
              padding:      "16px 20px",
              minWidth:     160,
              textAlign:    "center",
              flex:         1,
            }}
          >
            <div
              style={{
                color:         t.color,
                fontSize:      11,
                fontWeight:    700,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom:  6,
              }}
            >
              {t.plan}
            </div>
            <div
              style={{ color: "#e8eaf0", fontSize: 22, fontWeight: 800, marginBottom: 10 }}
            >
              {t.price}
            </div>
            {t.features.map((f) => (
              <div key={f} style={{ color: "#8b92a9", fontSize: 12, marginBottom: 4 }}>
                ✓ {f}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── useAuthToken ─────────────────────────────────────────────────────────────
// Returns a getToken() function that provides a fresh Clerk JWT.
// Use this to add Authorization headers to all proxy API calls.
export function useAuthToken() {
  const { getToken } = useAuth();
  return {
    getToken: () => getToken({ template: "default" }),
  };
}

// ─── useAuthFetch ─────────────────────────────────────────────────────────────
// Drop-in replacement for fetch() that automatically adds the JWT header.
// Replace all fetch(`${PROXY_BASE}/...`) calls in crypto_algo_trader.jsx with this.
//
// In crypto_algo_trader.jsx, add near the top of the CryptoAlgoTrader component:
//   const authFetch = useAuthFetch();
// Then replace:
//   fetch(`${PROXY_BASE}/balance`, opts)
// With:
//   authFetch(`${PROXY_BASE}/balance`, opts)
export function useAuthFetch() {
  const { getToken } = useAuth();

  return React.useCallback(
    async (url, opts = {}) => {
      const token = await getToken({ template: "default" });
      return fetch(url, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${token}`,
          ...opts.headers,
        },
      });
    },
    [getToken]
  );
}

// ─── useCurrentPlan ───────────────────────────────────────────────────────────
// Reads the user's plan from Clerk public metadata (set by Stripe webhook).
// Use this to gate features in the UI.
export function useCurrentPlan() {
  const { user } = useUser();
  const plan = user?.publicMetadata?.plan || "free";

  return {
    plan,
    canUseLive:   plan === "pro" || plan === "pro_ai",
    canUseAI:     plan === "pro_ai",
    maxCoins:     plan === "pro_ai" ? 50 : plan === "pro" ? 10 : 1,
    isSubscribed: plan !== "free",
    isLoaded:     !!user,
  };
}

// ─── UpgradeBanner ────────────────────────────────────────────────────────────
// Inline banner shown when a user tries to access a feature above their plan.
//
// Usage:
//   const { canUseAI } = useCurrentPlan();
//   {!canUseAI && <UpgradeBanner feature="DeepSeek agent" requiredPlan="Pro AI" />}
export function UpgradeBanner({ feature, requiredPlan }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      style={{
        padding:        "10px 14px",
        borderRadius:   8,
        background:     "#fef3c711",
        border:         "0.5px solid #f59e0b",
        fontSize:       12,
        color:          "#92400e",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        gap:            12,
        marginBottom:   8,
      }}
    >
      <span>
        🔒 <strong>{feature}</strong> requires the <strong>{requiredPlan}</strong> plan.
      </span>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <a
          href="/upgrade"
          style={{ color: "#f59e0b", fontWeight: 700, textDecoration: "none", fontSize: 12 }}
        >
          Upgrade →
        </a>
        <button
          onClick={() => setDismissed(true)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#92400e", fontSize: 14, lineHeight: 1, padding: 0,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
