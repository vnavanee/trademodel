import React, { useState, useCallback } from "react";
import { SignedIn, SignedOut, useUser } from "@clerk/clerk-react";
import { AuthScreen } from "./clerk_integration";
import CryptoAlgoTrader from "./crypto_algo_trader";

const PROXY_BASE = import.meta.env.VITE_PROXY_BASE
  || "https://coinbaseticker-283150216453.europe-west1.run.app";

const APP_NAME    = "Algo Trader";
const SUPPORT_EMAIL = "support@yourdomain.com"; // ← update this

// ─── Error logger ─────────────────────────────────────────────────────────────
// All errors go to console (Cloud Run captures these as structured logs).
// Users never see raw error details.
function logError(context, err, extra = {}) {
  console.error(`[${context}]`, {
    message: err?.message || String(err),
    code:    err?.code,
    status:  err?.status,
    ...extra,
    timestamp: new Date().toISOString(),
  });
}

// ─── ContactDialog ────────────────────────────────────────────────────────────
function ContactDialog({ reason, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999, padding: 24,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 14, padding: "32px 36px",
        maxWidth: 440, width: "100%", border: "0.5px solid #2d3353",
        boxShadow: "0 0 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
        <h2 style={{ color: "#e8eaf0", fontSize: 18, fontWeight: 700, margin: "0 0 10px", textAlign: "center" }}>
          Something went wrong
        </h2>
        <p style={{ color: "#8b92a9", fontSize: 14, lineHeight: 1.6, margin: "0 0 20px", textAlign: "center" }}>
          {reason || "An unexpected error occurred. Our team has been notified."}
        </p>
        <div style={{
          background: "#0f1117", borderRadius: 8, padding: "14px 16px",
          marginBottom: 20, border: "0.5px solid #2d3353",
        }}>
          <p style={{ color: "#555b73", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            Need help? Contact us at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "#6366f1" }}>{SUPPORT_EMAIL}</a>
            {" "}and we'll get back to you within 24 hours.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => window.location.reload()}
            style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
              background: "#6366f1", color: "#fff", fontWeight: 700, fontSize: 14,
              cursor: "pointer", fontFamily: "inherit" }}>
            Try again
          </button>
          <button onClick={onClose}
            style={{ flex: 1, padding: "10px 0", borderRadius: 8,
              border: "0.5px solid #2d3353", background: "transparent",
              color: "#8b92a9", fontWeight: 600, fontSize: 14,
              cursor: "pointer", fontFamily: "inherit" }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TermsModal ───────────────────────────────────────────────────────────────
function TermsModal({ type, onClose }) {
  const isPrivacy = type === "privacy";
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999, padding: 24,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 14, maxWidth: 620, width: "100%",
        maxHeight: "80vh", display: "flex", flexDirection: "column",
        border: "0.5px solid #2d3353",
      }}>
        <div style={{ padding: "20px 24px", borderBottom: "0.5px solid #2d3353",
          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ color: "#e8eaf0", fontSize: 16, fontWeight: 700, margin: 0 }}>
            {isPrivacy ? "Privacy Policy" : "Terms of Service"}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none",
            color: "#555b73", fontSize: 20, cursor: "pointer", padding: "0 4px" }}>×</button>
        </div>
        <div style={{ overflow: "auto", padding: "20px 24px", flex: 1,
          color: "#8b92a9", fontSize: 13, lineHeight: 1.8 }}>
          {isPrivacy ? <PrivacyContent /> : <TermsContent />}
        </div>
        <div style={{ padding: "16px 24px", borderTop: "0.5px solid #2d3353" }}>
          <button onClick={onClose} style={{ width: "100%", padding: "10px 0",
            borderRadius: 8, border: "none", background: "#6366f1",
            color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer",
            fontFamily: "inherit" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function TermsContent() {
  return (
    <>
      <h3 style={{ color: "#e8eaf0", marginTop: 0 }}>1. Acceptance of Terms</h3>
      <p>By accessing or using {APP_NAME} ("the Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>

      <h3 style={{ color: "#e8eaf0" }}>2. Description of Service</h3>
      <p>{APP_NAME} is an algorithmic cryptocurrency trading tool that provides automated signal generation, trade execution, and portfolio monitoring. The Service is provided for informational and automation purposes only.</p>

      <h3 style={{ color: "#e8eaf0" }}>3. Financial Disclaimer</h3>
      <p><strong style={{ color: "#ef4444" }}>IMPORTANT:</strong> {APP_NAME} is not a licensed financial advisor. Nothing in this Service constitutes financial advice, investment advice, trading advice, or any other type of advice. Cryptocurrency trading involves substantial risk of loss. Past performance of the algorithm does not guarantee future results. You may lose some or all of your invested capital. Only trade with funds you can afford to lose.</p>

      <h3 style={{ color: "#e8eaf0" }}>4. User Responsibilities</h3>
      <p>You are solely responsible for: (a) all trading decisions made using the Service; (b) securing your exchange API keys; (c) complying with applicable laws in your jurisdiction; (d) any taxes arising from your trading activity.</p>

      <h3 style={{ color: "#e8eaf0" }}>5. API Key Security</h3>
      <p>Your exchange API keys are encrypted at rest using AES-256 and transmitted only over HTTPS. We never store your API keys in plaintext. You should only provide API keys with trading permissions appropriate for your use case. We recommend enabling IP restrictions on your exchange API keys.</p>

      <h3 style={{ color: "#e8eaf0" }}>6. Subscription and Billing</h3>
      <p>Paid subscriptions are billed monthly through Stripe. You may cancel at any time. Refunds are not provided for partial billing periods. We reserve the right to change subscription pricing with 30 days notice.</p>

      <h3 style={{ color: "#e8eaf0" }}>7. Limitation of Liability</h3>
      <p>To the maximum extent permitted by law, {APP_NAME} and its operators shall not be liable for any trading losses, lost profits, or indirect damages arising from use of the Service.</p>

      <h3 style={{ color: "#e8eaf0" }}>8. Service Availability</h3>
      <p>We strive for 99.9% uptime but do not guarantee uninterrupted service. We are not liable for losses arising from service outages, API failures, or connectivity issues.</p>

      <h3 style={{ color: "#e8eaf0" }}>9. Termination</h3>
      <p>We reserve the right to suspend or terminate accounts that violate these terms, engage in market manipulation, or use the Service in any unlawful manner.</p>

      <h3 style={{ color: "#e8eaf0" }}>10. Changes to Terms</h3>
      <p>We may update these terms at any time. Continued use of the Service after changes constitutes acceptance of the updated terms.</p>

      <p style={{ color: "#555b73", fontSize: 11 }}>Last updated: {new Date().getFullYear()}</p>
    </>
  );
}

function PrivacyContent() {
  return (
    <>
      <h3 style={{ color: "#e8eaf0", marginTop: 0 }}>1. Information We Collect</h3>
      <p>We collect: (a) <strong style={{ color: "#e8eaf0" }}>Account information</strong> — email address and name provided during signup via Clerk; (b) <strong style={{ color: "#e8eaf0" }}>Trading settings</strong> — your indicator configuration, exit rules, and trading preferences; (c) <strong style={{ color: "#e8eaf0" }}>Transaction history</strong> — records of simulated and live trades executed through the Service; (d) <strong style={{ color: "#e8eaf0" }}>API keys</strong> — encrypted exchange credentials you provide.</p>

      <h3 style={{ color: "#e8eaf0" }}>2. How We Use Your Information</h3>
      <p>Your information is used solely to: provide and improve the Service; authenticate your account; process subscription payments via Stripe; store your trading settings across sessions. We do not sell, rent, or share your personal information with third parties for marketing purposes.</p>

      <h3 style={{ color: "#e8eaf0" }}>3. Data Storage and Security</h3>
      <p>Your data is stored in Supabase (PostgreSQL) with row-level security — you can only access your own data. Exchange API keys are encrypted with AES-256 before storage. All data is transmitted over TLS/HTTPS. We implement industry-standard security practices.</p>

      <h3 style={{ color: "#e8eaf0" }}>4. Third-Party Services</h3>
      <p>We use: <strong style={{ color: "#e8eaf0" }}>Clerk</strong> for authentication; <strong style={{ color: "#e8eaf0" }}>Stripe</strong> for payment processing (we never store card details); <strong style={{ color: "#e8eaf0" }}>Supabase</strong> for database hosting; <strong style={{ color: "#e8eaf0" }}>Google Cloud Run</strong> for server infrastructure. Each has their own privacy policy.</p>

      <h3 style={{ color: "#e8eaf0" }}>5. Data Retention</h3>
      <p>We retain your data for as long as your account is active. Transaction history is retained for 12 months on the free plan, 36 months on paid plans. You may request deletion of your account and all associated data at any time by contacting us.</p>

      <h3 style={{ color: "#e8eaf0" }}>6. Your Rights</h3>
      <p>You have the right to: access your personal data; correct inaccurate data; request deletion of your data; export your transaction history as CSV; withdraw consent at any time. Contact us at <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "#6366f1" }}>{SUPPORT_EMAIL}</a> to exercise these rights.</p>

      <h3 style={{ color: "#e8eaf0" }}>7. Cookies</h3>
      <p>We use only essential cookies for authentication session management (via Clerk). We do not use tracking or advertising cookies.</p>

      <h3 style={{ color: "#e8eaf0" }}>8. Contact</h3>
      <p>For privacy-related enquiries: <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "#6366f1" }}>{SUPPORT_EMAIL}</a></p>

      <p style={{ color: "#555b73", fontSize: 11 }}>Last updated: {new Date().getFullYear()}</p>
    </>
  );
}

// ─── PlanSelector ─────────────────────────────────────────────────────────────
function PlanSelector({ onFree }) {
  const [loading,      setLoading]      = useState(null);
  const [error,        setError]        = useState(null);
  const [termsModal,   setTermsModal]   = useState(null);   // "terms" | "privacy" | null
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [contact,      setContact]      = useState(false);

  const choosePlan = async (plan) => {
    if (!termsAccepted) {
      setError("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    if (plan === "free") { onFree(); return; }

    setLoading(plan);
    setError(null);
    try {
      let token = null;
      for (let i = 0; i < 10; i++) {
        token = await window.Clerk?.session?.getToken();
        if (token) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!token) throw new Error("auth_timeout");

      const res  = await fetch(`${PROXY_BASE}/subscribe`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          plan,
          successUrl: window.location.origin + "/?upgraded=1",
          cancelUrl:  window.location.origin + "/",
        }),
      });

      const text = await res.text();
      let data;
      try   { data = JSON.parse(text); }
      catch { data = {}; }

      // Log full detail to console — never shown to user
      if (!res.ok) {
        logError("PlanSelector.subscribe", { message: data.error, code: data.code, status: res.status }, { plan });
        if (res.status === 503) {
          setContact(true); // DB unavailable — show contact dialog
          return;
        }
        throw new Error("checkout_failed");
      }
      if (!data.url) { throw new Error("no_checkout_url"); }
      window.location.href = data.url;

    } catch (e) {
      logError("PlanSelector.subscribe.catch", e, { plan });
      const friendly = e.message === "Failed to fetch"
        ? "Unable to reach the server. Please check your connection and try again."
        : e.message === "auth_timeout"
        ? "Authentication timed out. Please refresh and try again."
        : "Something went wrong starting your subscription. Please try again or contact support.";
      setError(friendly);
      setLoading(null);
    }
  };

  const plans = [
    { id: "free",   label: "Free",   price: "$0",     color: "#94a3b8",
      features: ["Simulation only", "BTC only", "Rule-based signals", "Transaction export"], cta: "Start free" },
    { id: "pro",    label: "Pro",    price: "$29/mo",  color: "#6366f1", badge: "Most popular",
      features: ["Live trading", "Up to 10 coins", "RF + LSTM models", "Transaction history"], cta: "Start Pro" },
    { id: "pro_ai", label: "Pro AI", price: "$49/mo",  color: "#10b981",
      features: ["Everything in Pro", "AI agent (5 LLMs)", "Adaptive TP/SL", "Up to 50 coins"], cta: "Start Pro AI" },
  ];

  return (
    <div style={{
      minHeight: "100vh", background: "linear-gradient(135deg, #0f1117 0%, #1a1f2e 100%)",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif",
      padding: "32px 16px", gap: 28,
    }}>
      {termsModal && <TermsModal type={termsModal} onClose={() => setTermsModal(null)} />}
      {contact    && <ContactDialog reason="We're having trouble connecting. Please try again shortly." onClose={() => setContact(false)} />}

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>₿</div>
        <h1 style={{ color: "#e8eaf0", fontSize: 24, fontWeight: 800, margin: 0 }}>Choose your plan</h1>
        <p style={{ color: "#555b73", fontSize: 14, marginTop: 8 }}>You can upgrade or downgrade anytime.</p>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center", maxWidth: 860 }}>
        {plans.map(p => (
          <div key={p.id} style={{
            background: "#1a1f2e", borderRadius: 12, padding: "28px 24px",
            border: `1.5px solid ${p.color}44`, flex: 1, minWidth: 220, maxWidth: 260,
            display: "flex", flexDirection: "column", gap: 16, position: "relative",
          }}>
            {p.badge && (
              <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                background: p.color, color: "#fff", fontSize: 10, fontWeight: 700,
                padding: "3px 12px", borderRadius: 20, whiteSpace: "nowrap" }}>{p.badge}</div>
            )}
            <div>
              <div style={{ color: p.color, fontSize: 12, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{p.label}</div>
              <div style={{ color: "#e8eaf0", fontSize: 28, fontWeight: 800 }}>{p.price}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              {p.features.map(f => (
                <div key={f} style={{ color: "#8b92a9", fontSize: 13, display: "flex", gap: 8 }}>
                  <span style={{ color: p.color, flexShrink: 0 }}>✓</span> {f}
                </div>
              ))}
            </div>
            <button onClick={() => choosePlan(p.id)} disabled={!!loading}
              style={{ padding: "10px 0", borderRadius: 8, border: "none",
                background: loading === p.id ? p.color + "66" : p.color,
                color: p.id === "free" ? "#1a1f2e" : "#fff",
                fontWeight: 700, fontSize: 14, cursor: loading ? "wait" : "pointer",
                fontFamily: "inherit", width: "100%",
                opacity: loading && loading !== p.id ? 0.5 : 1 }}>
              {loading === p.id ? "Loading..." : p.cta}
            </button>
          </div>
        ))}
      </div>

      {/* Terms acceptance checkbox */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, maxWidth: 480,
        cursor: "pointer", padding: "12px 16px", borderRadius: 9,
        border: `0.5px solid ${termsAccepted ? "#6366f144" : "#2d3353"}`,
        background: termsAccepted ? "#6366f108" : "transparent" }}>
        <input type="checkbox" checked={termsAccepted}
          onChange={e => { setTermsAccepted(e.target.checked); setError(null); }}
          style={{ marginTop: 2, flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: "#8b92a9", lineHeight: 1.6 }}>
          I have read and agree to the{" "}
          <button onClick={e => { e.preventDefault(); setTermsModal("terms"); }}
            style={{ background: "none", border: "none", color: "#6366f1",
              cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" }}>
            Terms of Service
          </button>
          {" "}and{" "}
          <button onClick={e => { e.preventDefault(); setTermsModal("privacy"); }}
            style={{ background: "none", border: "none", color: "#6366f1",
              cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" }}>
            Privacy Policy
          </button>
          , including the financial risk disclaimer.
        </span>
      </label>

      {error && (
        <div style={{ maxWidth: 480, width: "100%", padding: "10px 14px", borderRadius: 8,
          background: "#fee2e222", border: "0.5px solid #ef4444",
          fontSize: 13, color: "#fca5a5", textAlign: "center" }}>
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
  const [choseFree, setChoseFree] = useState(false);
  const [error,     setError]     = useState(null);

  const handleError = useCallback((context, err) => {
    logError(context, err);
    setError("Something went wrong. Please try again or contact support.");
  }, []);

  if (!isLoaded) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f1117", display: "flex",
        alignItems: "center", justifyContent: "center", color: "#555b73", fontSize: 14 }}>
        Loading...
      </div>
    );
  }

  const justUpgraded = new URLSearchParams(window.location.search).get("upgraded") === "1";
  if (justUpgraded) {
    window.history.replaceState({}, "", window.location.pathname);
    return <CryptoAlgoTrader onError={handleError} />;
  }

  const plan = user?.publicMetadata?.plan;
  if (plan || choseFree) return <CryptoAlgoTrader onError={handleError} />;

  return <PlanSelector onFree={() => setChoseFree(true)} />;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <>
      <SignedOut><AuthScreen /></SignedOut>
      <SignedIn><AuthenticatedApp /></SignedIn>
    </>
  );
}
