import React, { useEffect, useState } from "react";

// ─── Onboarding Tour ────────────────────────────────────────────────────────
// A lightweight, dependency-free step-by-step product tour. Highlights a
// target element (via CSS selector) with a spotlight cutout and shows a
// tooltip card with Next / Back / Skip controls positioned next to it.
//
// Kept in its own file because it's a self-contained, reusable overlay with
// no dependency on the dashboard's internal state — it only needs a list of
// steps and callback handlers, making it easy to reuse or restyle later
// without touching the (very large) main dashboard file.
//
// Usage:
//   <OnboardingTour
//     steps={TOUR_STEPS}
//     stepIndex={tourStep}
//     onNext={() => setTourStep(s => s + 1)}
//     onBack={() => setTourStep(s => s - 1)}
//     onSkip={() => setTourActive(false)}
//     onFinish={() => setTourActive(false)}
//   />
//
// Each step shape:
//   {
//     target: "[data-tour='settings-btn']" | null,  // CSS selector or null for centered card
//     title: "Open Settings",
//     body: "Click here to add your exchange API keys...",
//     placement: "bottom" | "top" | "left" | "right", // relative to target (default "bottom")
//   }
//
// The parent component is responsible for any side effects needed to make a
// step's target exist in the DOM (e.g. opening a modal before advancing to
// a step whose target lives inside that modal). This component only measures
// and highlights — it does not know about your app's state.

export default function OnboardingTour({ steps, stepIndex, onNext, onBack, onSkip, onFinish }) {
  const [rect, setRect] = useState(null);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;
  const isFirst = stepIndex === 0;

  // Measure the target element's position. Re-measure on resize, and retry
  // a few times after the step changes in case the target is inside a modal
  // that the parent just opened (needs a moment to mount).
  useEffect(() => {
    if (!step?.target) { setRect(null); return; }

    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(step.target);
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      requestAnimationFrame(() => {
        if (cancelled) return;
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
    };

    const timers = [50, 250, 550].map(ms => setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [stepIndex, step]);

  if (!step) return null;

  const PAD = 8; // spotlight padding around the target element
  const GAP = 14; // gap between spotlight and tooltip

  const tooltipStyle = (() => {
    if (!rect) {
      // No target (welcome/finish card, or target not found) — center it
      return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }
    switch (step.placement || "bottom") {
      case "top":
        return { position: "fixed", top: rect.top - GAP, left: rect.left + rect.width / 2, transform: "translate(-50%, -100%)" };
      case "left":
        return { position: "fixed", top: rect.top + rect.height / 2, left: rect.left - GAP, transform: "translate(-100%, -50%)" };
      case "right":
        return { position: "fixed", top: rect.top + rect.height / 2, left: rect.left + rect.width + GAP, transform: "translate(0, -50%)" };
      case "bottom":
      default:
        return { position: "fixed", top: rect.top + rect.height + GAP, left: rect.left + rect.width / 2, transform: "translate(-50%, 0)" };
    }
  })();

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 20000, pointerEvents: "none", fontFamily: "inherit" }}>
      {/* Dimmed backdrop with spotlight cutout (box-shadow trick — no clip-path needed) */}
      {rect ? (
        <div
          style={{
            position: "fixed",
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.65)",
            border: "1.5px solid #6366f1",
            transition: "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)" }} />
      )}

      {/* Tooltip card */}
      <div
        style={{
          ...tooltipStyle,
          pointerEvents: "auto",
          width: 300,
          maxWidth: "90vw",
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-tertiary, #333)",
          borderRadius: 12,
          padding: "16px 18px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Step {stepIndex + 1} of {steps.length}
          </span>
          <button
            onClick={onSkip}
            style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            Skip tour
          </button>
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 6 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>
          {step.body}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {/* Progress dots */}
          <div style={{ display: "flex", gap: 4 }}>
            {steps.map((_, i) => (
              <span
                key={i}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: i === stepIndex ? "#6366f1" : "var(--color-border-tertiary)",
                }}
              />
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {!isFirst && (
              <button
                onClick={onBack}
                style={{
                  padding: "6px 12px",
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 600,
                  border: "0.5px solid var(--color-border-secondary, #444)",
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Back
              </button>
            )}
            <button
              onClick={isLast ? onFinish : onNext}
              style={{
                padding: "6px 14px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 700,
                border: "none",
                background: "#6366f1",
                color: "#fff",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {isLast ? "Finish" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Default tour content ───────────────────────────────────────────────────
// Exported separately so the parent can customize, reorder, or filter steps
// (e.g. skipping the "view a session" step if the user has no saved sessions).
//
// beforeShow: optional callback the parent should run when navigating TO this
// step (in either direction) — typically opening a modal or tab so the
// step's target element exists in the DOM. The parent wires this up itself;
// this array just documents which side effect each step expects, via the
// `requires` field, so the parent's beforeShow dispatcher can react to it.

export const TOUR_STEPS = [
  {
    target: null,
    title: "Welcome to Automation Trader 👋",
    body: "This quick tour walks through setting up your first automated trading strategy — from adding an exchange to going live. Takes about a minute.",
  },
  {
    target: "[data-tour='settings-btn']",
    title: "Open Settings",
    body: "Everything starts here — your exchange connection, coins, signal strategy, and risk rules all live in Settings.",
    placement: "bottom",
    requires: "openSettings",
  },
  {
    target: "[data-tour='tab-provider']",
    title: "Choose your exchange",
    body: "Pick which exchange to trade on and paste in your API keys. Sandbox/test mode is available if you want to try it without real credentials.",
    placement: "bottom",
    requires: "settingsTab:provider",
  },
  {
    target: "[data-tour='tab-signals']",
    title: "Pick your coins and strategy",
    body: "The Signals tab is where you choose which coins to trade and how the algorithm decides when to buy or sell.",
    placement: "bottom",
    requires: "settingsTab:signals",
  },
  {
    target: "[data-tour='coins-select']",
    title: "Active trading pairs",
    body: "Toggle which coins the algorithm should watch and trade. You can change this anytime.",
    placement: "top",
    requires: "settingsTab:signals",
  },
  {
    target: "[data-tour='signal-source-select']",
    title: "How decisions get made",
    body: "Start with Rules (classic technical indicators) if you're new. Machine learning options (Random Forest, LSTM, Reinforcement Learning) improve with more data but take longer to warm up.",
    placement: "top",
    requires: "settingsTab:signals",
  },
  {
    target: "[data-tour='trade-size-input']",
    title: "Set your starting balance",
    body: "This is how much (virtual or real) money each coin starts with. It compounds with profit and loss as trades close.",
    placement: "top",
    requires: "settingsTab:signals",
  },
  {
    target: "[data-tour='paper-trade-btn']",
    title: "Start with paper trading",
    body: "Paper trading simulates the strategy with no real money — the best way to see how your settings perform before risking anything.",
    placement: "bottom",
    requires: "closeSettings",
  },
  {
    target: "[data-tour='sessions-btn']",
    title: "Manage your sessions",
    body: "Once you're happy with a strategy, use Sessions to save paper trades, launch live trading, and run multiple tests side by side.",
    placement: "bottom",
  },
  {
    target: "[data-tour='session-eye-icon']",
    title: "Check in anytime",
    body: "Click the eye icon on any session to view its balance, trades, and settings without interrupting it — even while it's running.",
    placement: "right",
    optional: true, // parent should skip this step if no session cards exist yet
  },
  {
    target: null,
    title: "You're all set 🎉",
    body: "That's the full flow: configure → paper trade → go live → monitor. You can restart this tour anytime from the help icon in the header.",
  },
];
