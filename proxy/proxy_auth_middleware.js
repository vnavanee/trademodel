// ============================================================
// AUTH MIDDLEWARE + NEW ENDPOINTS for coinbase-proxy/index.js
// ============================================================
// Add these to your existing index.js.
// 
// New dependencies — add to package.json:
//   npm install @clerk/clerk-sdk-node @supabase/supabase-js node-fetch
//
// New Cloud Run environment variables to set:
//   CLERK_SECRET_KEY        sk_live_xxxxxxxxxxxx
//   SUPABASE_URL            https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY    eyJhbGciOiJSUzI1NiIsInR5cCI6Ikp...   (service_role key)
//   STRIPE_SECRET_KEY       sk_live_xxxxxxxxxxxx
//   STRIPE_WEBHOOK_SECRET   whsec_xxxxxxxxxxxx
//   ENCRYPTION_KEY          (32 random bytes as hex — for AES-256 key encryption)
// ============================================================

const crypto = require("crypto");

// ─── Body parser ──────────────────────────────────────────────────────────────
// Cloud Run Functions Framework may pre-parse JSON onto req.body, or stream raw.
// This handles both cases — mirrors the readBody in index.js.
function readBody(req) {
  // Already parsed by Functions Framework
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return Promise.resolve(req.body);
    if (typeof req.body === "string") {
      try   { return Promise.resolve(JSON.parse(req.body)); }
      catch { return Promise.resolve({}); }
    }
  }
  // Raw stream — read and parse manually
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try   { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error(`Invalid JSON body: ${data.slice(0, 100)}`)); }
    });
    req.on("error", reject);
  });
}

// ─── Lazy client getters ──────────────────────────────────────────────────────
// Clients are created on first use so missing env vars don't crash the process
// at startup — Cloud Run can bind the port before any auth endpoint is called.
let _clerk = null, _supabase = null;

function getClerk() {
  if (!_clerk) {
    const { createClerkClient } = require("@clerk/clerk-sdk-node");
    if (!process.env.CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY not set");
    _clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  }
  return _clerk;
}

function getSupabase() {
  if (!_supabase) {
    const { createClient } = require("@supabase/supabase-js");
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
      throw new Error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _supabase;
}

// ─── Key encryption helpers (for exchange API keys at rest) ──────────────────
const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex"); // 32 bytes

function encryptValue(plaintext) {
  if (!ENC_KEY.length) return plaintext; // dev mode: no encryption
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptValue(ciphertext) {
  if (!ENC_KEY.length || !ciphertext.includes(":")) return ciphertext;
  const [ivHex, encHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENC_KEY, Buffer.from(encHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

// Recursively encrypt all string values that look like API keys in the creds object
const KEY_FIELDS = ["apiKey","secretKey","privateKey","passphrase"];
function encryptCreds(creds) {
  const clone = JSON.parse(JSON.stringify(creds));
  if (clone.keys) {
    for (const exchange of Object.values(clone.keys)) {
      for (const field of KEY_FIELDS) {
        if (exchange[field]) exchange[field] = encryptValue(exchange[field]);
      }
    }
  }
  return clone;
}
function decryptCreds(creds) {
  const clone = JSON.parse(JSON.stringify(creds));
  if (clone.keys) {
    for (const exchange of Object.values(clone.keys)) {
      for (const field of KEY_FIELDS) {
        if (exchange[field]) exchange[field] = decryptValue(exchange[field]);
      }
    }
  }
  return clone;
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
// Call this at the top of any authenticated endpoint.
// Returns { userId, plan } or throws with HTTP 401/403.
async function requireAuth(req, res) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return null;
  }
  try {
    const payload = await getClerk().verifyToken(token);
    const userId  = payload.sub;

    // If Supabase is not configured, skip DB entirely
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      console.warn("[auth] Supabase not configured — returning free plan");
      return { userId, plan: "free" };
    }

    // Try to find user row in Supabase
    let user = null, fetchErr = null;
    try {
      const result = await getSupabase()
        .from("users")
        .select("plan, is_active, email")
        .eq("id", userId)
        .single();
      user     = result.data;
      fetchErr = result.error;
    } catch (e) {
      // Network-level failure — Supabase may be paused or unreachable
      const isPaused = e.message?.includes("fetch") || e.message?.includes("ECONNREFUSED")
        || e.message?.includes("network") || e.message?.includes("timeout");
      if (isPaused) {
        console.error("[auth] Supabase unreachable:", e.message, "— visit supabase.com to resume project");
        res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
        return null;
      }
      throw e;
    }

    // Supabase paused returns a specific error structure
    if (fetchErr && (
      fetchErr.message?.includes("Project paused") ||
      fetchErr.message?.includes("503") ||
      fetchErr.code === "57P03" ||
      fetchErr.message?.includes("upstream connect error")
    )) {
      console.error("[auth] Supabase paused:", fetchErr.code, fetchErr.message);
      res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
      return null;
    }

    if (fetchErr && fetchErr.code !== "PGRST116") {
      console.error("[auth] DB fetch error:", fetchErr.code, fetchErr.message);
    }

    // If user row doesn't exist yet — create it automatically with plan:"free"
    if (!user || fetchErr?.code === "PGRST116") {
      console.log(`[auth] user ${userId} not in DB — auto-creating`);

      // Pull email from Clerk — gracefully skip if CLERK_SECRET_KEY not set
      let email = payload.email || `${userId}@unknown.local`;
      try {
        const clerkUser = await getClerk().users.getUser(userId);
        email = clerkUser.emailAddresses?.[0]?.emailAddress || email;
        console.log(`[auth] got email from Clerk: ${email}`);
      } catch (e) {
        console.warn(`[auth] could not fetch email from Clerk: ${e.message}`);
      }

      // Use service role client — bypasses RLS entirely
      const sb = getSupabase();
      const { data: inserted, error: insertErr } = await sb
        .from("users")
        .upsert(
          { id: userId, email, display_name: email, plan: "free", is_active: true },
          { onConflict: "id", ignoreDuplicates: false }
        )
        .select("plan, is_active")
        .single();

      if (insertErr) {
        console.error("[auth] upsert error code:", insertErr.code, "msg:", insertErr.message, "details:", insertErr.details, "hint:", insertErr.hint);

        // Common error codes and their fixes
        const errGuide = {
          "42P01": "The 'users' table does not exist — run supabase_schema.sql in the Supabase SQL Editor",
          "42501": "Permission denied — SUPABASE_SERVICE_KEY must be the service_role key, not the anon key",
          "23505": "Duplicate key — row already exists (concurrent insert). This is safe to ignore.",
          "PGRST301": "JWT error — SUPABASE_SERVICE_KEY may be invalid or expired",
        };
        const hint = errGuide[insertErr.code] || "Check SUPABASE_URL and SUPABASE_SERVICE_KEY env vars on Cloud Run";

        // Final retry — row may have been created by a concurrent request
        try {
          const { data: retry } = await sb
            .from("users").select("plan, is_active").eq("id", userId).single();
          if (retry) {
            console.log("[auth] row found on retry after insert error — continuing");
            return { userId, plan: retry.plan || "free" };
          }
        } catch (_) {}

        // If it's a duplicate key error (23505), the row exists — try reading it
        if (insertErr.code === "23505") {
          const { data: existing } = await sb
            .from("users").select("plan, is_active").eq("id", userId).maybeSingle();
          if (existing) return { userId, plan: existing.plan || "free" };
        }

        res.status(500).json({ error: "Account setup failed. Please try again or contact support." });
        return null;
      }

      console.log(`[auth] auto-created user ${userId} email=${email} plan=free`);
      return { userId, plan: inserted?.plan || "free" };
    }

    if (!user.is_active) {
      console.warn("[auth] inactive account:", userId);
      res.status(403).json({ error: "Account unavailable. Please contact support." });
      return null;
    }

    return { userId, plan: user.plan || "free" };

  } catch (e) {
    console.error("[auth] token verification failed:", e.message);
    res.status(401).json({ error: "Authentication failed. Please sign in again." });
    return null;
  }
}

// Plan feature gating helper
function requirePlan(res, userPlan, requiredPlan) {
  const order = ["free", "pro", "pro_ai"];
  if (order.indexOf(userPlan) < order.indexOf(requiredPlan)) {
    res.status(403).json({
      error: `This feature requires the ${requiredPlan} plan`,
      currentPlan: userPlan,
      requiredPlan,
    });
    return false;
  }
  return true;
}

// ─── NEW ROUTE: GET /settings ─────────────────────────────────────────────────
// Returns the user's saved creds JSON with API keys decrypted.
async function handleGetSettings(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { data, error } = await getSupabase()
    .from("user_settings")
    .select("creds, updated_at")
    .eq("user_id", auth.userId)
    .single();

  if (error && error.code !== "PGRST116") { // PGRST116 = no rows found
    console.error("[settings/get] db error:", error.code, error.message);
    return res.status(500).json({ error: "Unable to load settings. Please try again." });
  }

  if (!data) {
    // First visit — return empty settings so client uses defaults
    return res.status(200).json({ creds: null, updatedAt: null });
  }

  const creds = decryptCreds(data.creds);
  return res.status(200).json({ creds, updatedAt: data.updated_at, plan: auth.plan });
}

// ─── NEW ROUTE: PUT /settings ─────────────────────────────────────────────────
// Saves (upserts) the user's creds JSON. Encrypts API keys before storage.
async function handlePutSettings(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body;
  try { body = await readBody(req); } catch (e) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const { creds } = body;
  if (!creds || typeof creds !== "object") {
    return res.status(400).json({ error: "Missing creds object in request body" });
  }

  // Enforce plan limits before saving
  const coinCount = creds.customCoins?.length || 1;
  const planLimits = { free: 1, pro: 10, pro_ai: 50 };
  const maxCoins = planLimits[auth.plan] || 1;
  if (coinCount > maxCoins) {
    return res.status(403).json({
      error: `Your ${auth.plan} plan allows up to ${maxCoins} coins. You have ${coinCount}.`,
    });
  }
  if (creds.agentMode && auth.plan !== "pro_ai") {
    return res.status(403).json({ error: "DeepSeek agent requires the Pro AI plan" });
  }
  if (creds.autoEnabled && auth.plan === "free") {
    return res.status(403).json({ error: "Live trading requires the Pro plan" });
  }

  const encrypted = encryptCreds(creds);

  const { error } = await getSupabase()
    .from("user_settings")
    .upsert({ user_id: auth.userId, creds: encrypted }, { onConflict: "user_id" });

  if (error) {
    console.error("[settings/put] db error:", error.code, error.message);
    return res.status(500).json({ error: "Unable to save settings. Please try again." });
  }

  // Audit log
  await getSupabase().from("audit_log").insert({
    user_id: auth.userId, event: "settings_save",
    metadata: { coins: creds.customCoins, provider: creds.provider },
  });

  return res.status(200).json({ ok: true });
}

// ─── NEW ROUTE: POST /transactions ────────────────────────────────────────────
// Persists a completed trade to the database.
async function handlePostTransaction(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body;
  try { body = await readBody(req); } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { type, coin, price, qty, usdValue, pnl, fees, netPnl, exitReason,
          agentReasoning, lstmTrend, lstmChangePct, lstmVol, rfDirProb,
          signalSource, mode, timestamp } = body;

  if (!type || !coin) return res.status(400).json({ error: "Missing type or coin" });

  // Enforce tx history limit per plan
  const limits = { free: 0, pro: 5000, pro_ai: 50000 };
  const limit = limits[auth.plan] || 0;
  if (limit === 0 && mode !== "simulation") {
    // Free plan: still allow simulation tx but not live
    return res.status(403).json({ error: "Transaction logging for live trades requires the Pro plan" });
  }

  const { error } = await getSupabase().from("transactions").insert({
    user_id: auth.userId, mode, type, coin,
    price: price || null, qty: qty || null, usd_value: usdValue || null,
    pnl: pnl || null, fees: fees || null, net_pnl: netPnl || null,
    exit_reason: exitReason || null, agent_reasoning: agentReasoning || null,
    lstm_trend: lstmTrend || null, lstm_change_pct: lstmChangePct || null,
    lstm_vol: lstmVol || null, rf_dir_prob: rfDirProb || null,
    signal_source: signalSource || null,
    timestamp: timestamp || new Date().toISOString(),
  });

  if (error) {
    console.error("[transactions/post] db error:", error);
    return res.status(500).json({ error: "Unable to save transaction. Please try again." });
  }

  return res.status(200).json({ ok: true });
}

// ─── NEW ROUTE: GET /transactions ─────────────────────────────────────────────
// Returns paginated transaction history for the current user.
async function handleGetTransactions(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const url = new URL(req.url, "http://localhost");
  const limit  = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const coin   = url.searchParams.get("coin");
  const mode   = url.searchParams.get("mode");

  let query = supabase
    .from("transactions")
    .select("*", { count: "exact" })
    .eq("user_id", auth.userId)
    .order("timestamp", { ascending: false })
    .range(offset, offset + limit - 1);

  if (coin) query = query.eq("coin", coin);
  if (mode) query = query.eq("mode", mode);

  const { data, count, error } = await query;
  if (error) {
    console.error("[transactions/get] db error:", error);
    return res.status(500).json({ error: "Unable to load transactions. Please try again." });
  }

  return res.status(200).json({ transactions: data, total: count, limit, offset });
}

// ─── NEW ROUTE: POST /webhook (Stripe) ───────────────────────────────────────
// Handles Stripe subscription lifecycle events.
// Must be registered in Stripe Dashboard → Webhooks → your Cloud Run URL/webhook
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

async function handleStripeWebhook(req, res) {
  const sig  = req.headers["stripe-signature"];
  const body = await readRawBody(req); // need raw bytes for signature verification

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("[webhook] signature verification failed:", e.message);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  console.log(`[webhook] Stripe event: ${event.type}`);
  const sub = event.data.object;

  // Map Stripe plan/price IDs to your plan names
  const PRICE_TO_PLAN = {
    [process.env.STRIPE_PRICE_PRO]:    "pro",
    [process.env.STRIPE_PRICE_PRO_AI]: "pro_ai",
  };

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const plan   = PRICE_TO_PLAN[sub.items?.data?.[0]?.price?.id] || "free";
      const userId = sub.metadata?.clerk_user_id;
      if (!userId) break;
      await getSupabase().from("subscriptions").upsert({
        user_id: userId, stripe_customer_id: sub.customer,
        stripe_sub_id: sub.id, plan, status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
      }, { onConflict: "stripe_sub_id" });
      // Update user plan
      await getSupabase().from("users").update({ plan }).eq("id", userId);
      // Update Clerk public metadata so frontend sees the new plan immediately
      await getClerk().users.updateUserMetadata(userId, { publicMetadata: { plan } });
      break;
    }
    case "customer.subscription.deleted": {
      const userId = sub.metadata?.clerk_user_id;
      if (!userId) break;
      await getSupabase().from("subscriptions").update({ status: "canceled" })
        .eq("stripe_sub_id", sub.id);
      await getSupabase().from("users").update({ plan: "free" }).eq("id", userId);
      await getClerk().users.updateUserMetadata(userId, { publicMetadata: { plan: "free" } });
      break;
    }
  }

  return res.status(200).json({ received: true });
}

// ─── NEW ROUTE: POST /subscribe ───────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the URL.
async function handleSubscribe(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // Guard: check Stripe is configured before doing anything
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({
      error: "Stripe not configured — set STRIPE_SECRET_KEY on Cloud Run",
    });
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    return res.status(400).json({ error: "Invalid request format. Please try again." });
  }

  console.log("[subscribe] body:", JSON.stringify(body));

  const { plan, successUrl, cancelUrl } = body;
  if (!plan) return res.status(400).json({ error: "Missing plan in request body" });

  const PRICE_IDS = {
    pro:    process.env.STRIPE_PRICE_PRO,
    pro_ai: process.env.STRIPE_PRICE_PRO_AI,
  };
  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(400).json({
      error: `Unknown plan "${plan}" or price ID not set. Set STRIPE_PRICE_PRO / STRIPE_PRICE_PRO_AI on Cloud Run.`,
    });
  }

  let stripe;
  try {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  } catch (e) {
    return res.status(500).json({
      error: `Stripe package not available: ${e.message}. Run: npm install stripe in coinbase-proxy/`,
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${req.headers.origin || "https://yourapp.netlify.app"}/?upgraded=1`,
      cancel_url:  cancelUrl  || `${req.headers.origin || "https://yourapp.netlify.app"}/`,
      metadata: { clerk_user_id: auth.userId },
      subscription_data: { metadata: { clerk_user_id: auth.userId } },
    });
    console.log(`[subscribe] created session ${session.id} for ${auth.userId} plan=${plan}`);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("[subscribe] Stripe error:", e.message);
    return res.status(502).json({
      error: `Stripe error: ${e.message}`,
      hint: "Check STRIPE_SECRET_KEY is a valid live/test secret key (sk_live_... or sk_test_...)",
    });
  }
}

// ─── NEW ROUTE: POST /users (Clerk webhook — user.created) ───────────────────
// Called by Clerk when a new user signs up (set up in Clerk Dashboard → Webhooks).
async function handleUserCreated(req, res) {
  // Verify Clerk webhook signature (install svix: npm i svix)
  const { Webhook } = require("svix");
  const wh   = new Webhook(process.env.CLERK_WEBHOOK_SECRET || "");
  const body = await readRawBody(req);
  let evt;
  try {
    evt = wh.verify(body, {
      "svix-id":        req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"],
    });
  } catch (e) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  if (evt.type === "user.created") {
    const { id, email_addresses, first_name, last_name } = evt.data;
    const email = email_addresses?.[0]?.email_address || "";
    await getSupabase().from("users").upsert({
      id, email,
      display_name: [first_name, last_name].filter(Boolean).join(" ") || email,
      plan: "free",
    }, { onConflict: "id" });
    console.log(`[users] created: ${id} ${email}`);
  }

  return res.status(200).json({ received: true });
}

// ─── RAW BODY HELPER (for Stripe/Clerk webhook signature verification) ────────
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── ROUTE REGISTRATION ───────────────────────────────────────────────────────
// Add these to your main request handler switch/if-else block in index.js:
//
//   if (route === "/settings" && req.method === "GET")  return handleGetSettings(req, res);
//   if (route === "/settings" && req.method === "PUT")  return handlePutSettings(req, res);
//   if (route === "/transactions" && req.method === "POST") return handlePostTransaction(req, res);
//   if (route === "/transactions" && req.method === "GET")  return handleGetTransactions(req, res);
//   if (route === "/subscribe" && req.method === "POST") return handleSubscribe(req, res);
//   if (route === "/webhook"   && req.method === "POST") return handleStripeWebhook(req, res);
//   if (route === "/users"     && req.method === "POST") return handleUserCreated(req, res);

module.exports = {
  requireAuth, requirePlan,
  handleGetSettings, handlePutSettings,
  handlePostTransaction, handleGetTransactions,
  handleSubscribe, handleStripeWebhook, handleUserCreated,
  encryptCreds, decryptCreds,
};

