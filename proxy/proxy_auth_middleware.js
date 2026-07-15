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

const { createClerkClient } = require("@clerk/clerk-sdk-node");
const { createClient }      = require("@supabase/supabase-js");
const crypto                = require("crypto");

// ─── Clients (initialised once at startup) ────────────────────────────────────
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,  // service role bypasses RLS for trusted writes
  { auth: { persistSession: false } }
);

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
    const payload = await clerk.verifyToken(token);
    const userId = payload.sub;

    // Fetch plan from Supabase (set by Stripe webhook)
    const { data: user } = await supabase
      .from("users")
      .select("plan, is_active")
      .eq("id", userId)
      .single();

    if (!user || !user.is_active) {
      res.status(403).json({ error: "Account inactive or not found" });
      return null;
    }
    return { userId, plan: user.plan || "free" };
  } catch (e) {
    console.error("[auth] token verification failed:", e.message);
    res.status(401).json({ error: "Invalid or expired token" });
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

  const { data, error } = await supabase
    .from("user_settings")
    .select("creds, updated_at")
    .eq("user_id", auth.userId)
    .single();

  if (error && error.code !== "PGRST116") { // PGRST116 = no rows found
    console.error("[settings/get] db error:", error);
    return res.status(500).json({ error: "Failed to load settings" });
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

  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: auth.userId, creds: encrypted }, { onConflict: "user_id" });

  if (error) {
    console.error("[settings/put] db error:", error);
    return res.status(500).json({ error: "Failed to save settings" });
  }

  // Audit log
  await supabase.from("audit_log").insert({
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

  const { error } = await supabase.from("transactions").insert({
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
    return res.status(500).json({ error: "Failed to save transaction" });
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
    return res.status(500).json({ error: "Failed to load transactions" });
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
      await supabase.from("subscriptions").upsert({
        user_id: userId, stripe_customer_id: sub.customer,
        stripe_sub_id: sub.id, plan, status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
      }, { onConflict: "stripe_sub_id" });
      // Update user plan
      await supabase.from("users").update({ plan }).eq("id", userId);
      // Update Clerk public metadata so frontend sees the new plan immediately
      await clerk.users.updateUserMetadata(userId, { publicMetadata: { plan } });
      break;
    }
    case "customer.subscription.deleted": {
      const userId = sub.metadata?.clerk_user_id;
      if (!userId) break;
      await supabase.from("subscriptions").update({ status: "canceled" })
        .eq("stripe_sub_id", sub.id);
      await supabase.from("users").update({ plan: "free" }).eq("id", userId);
      await clerk.users.updateUserMetadata(userId, { publicMetadata: { plan: "free" } });
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

  let body;
  try { body = await readBody(req); } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { plan, successUrl, cancelUrl } = body;
  const PRICE_IDS = {
    pro:    process.env.STRIPE_PRICE_PRO,
    pro_ai: process.env.STRIPE_PRICE_PRO_AI,
  };
  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: `Unknown plan: ${plan}` });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl || "https://yourapp.netlify.app/?upgraded=1",
    cancel_url:  cancelUrl  || "https://yourapp.netlify.app/",
    metadata: { clerk_user_id: auth.userId },
    subscription_data: { metadata: { clerk_user_id: auth.userId } },
  });

  return res.status(200).json({ url: session.url });
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
    await supabase.from("users").upsert({
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
