import React from "react";
import { SignedIn, SignedOut } from "@clerk/clerk-react";
import { AuthScreen } from "./clerk_integration";
import CryptoAlgoTrader from "./crypto_algo_trader";

// ─── App ──────────────────────────────────────────────────────────────────────
// Root component. Clerk's <SignedOut> / <SignedIn> gates the entire dashboard.
// Unauthenticated visitors see AuthScreen (login + pricing).
// Authenticated users see the full trading dashboard wrapped in ErrorBoundary.
export default function App() {
  return (
    <>
      <SignedOut>
        <AuthScreen />
      </SignedOut>
      <SignedIn>
        <CryptoAlgoTrader />
      </SignedIn>
    </>
  );
}
