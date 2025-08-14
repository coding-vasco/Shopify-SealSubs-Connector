// server.js
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';

// ---------- ENV ----------
const {
  // one domain + token (and optional secret) per region/shop
  SHOP_DOMAIN_UK, SHOP_DOMAIN_EU, SHOP_DOMAIN_US,
  SEAL_SUBS_TOKEN_UK, SEAL_SUBS_TOKEN_EU, SEAL_SUBS_TOKEN_US,
  SEAL_SUBS_SECRET_UK, SEAL_SUBS_SECRET_EU, SEAL_SUBS_SECRET_US,

  // diagnostics
  FETCH_TIMEOUT_MS = '10000',
  DEBUG_ERRORS = 'false'
} = process.env;

// ---------- Region map ----------
const regions = [
  { code: 'UK', shop: SHOP_DOMAIN_UK, token: SEAL_SUBS_TOKEN_UK, secret: SEAL_SUBS_SECRET_UK },
  { code: 'EU', shop: SHOP_DOMAIN_EU, token: SEAL_SUBS_TOKEN_EU, secret: SEAL_SUBS_SECRET_EU },
  { code: 'US', shop: SHOP_DOMAIN_US, token: SEAL_SUBS_TOKEN_US, secret: SEAL_SUBS_SECRET_US },
].filter(r => r.shop);

const byShop = new Map(regions.map(r => [r.shop, r]));
const isValidShop = s => /^[a-z0-9-]+\.myshopify\.com$/.test(String(s || ''));
const tscEq = (a,b) => {
  const A = Buffer.from(String(a||''), 'utf8');
  const B = Buffer.from(String(b||''), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A,B);
};
const timeoutMs = parseInt(FETCH_TIMEOUT_MS, 10) || 10000;
const debug = (DEBUG_ERRORS || '').toLowerCase() === 'true';

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '200kb' }));

// ---------- Utils ----------
function errRes(res, code, msg, details) {
  const body = { error: msg };
  if (debug && details) body.details = details;
  return res.status(code).json(body);
}
async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
function safeJson(txt) { try { return JSON.parse(txt); } catch { return null; } }

// ---------- Health ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'SEAL_ONLY',
    shops: regions.map(r => r.shop),
    sealConfigured: Object.fromEntries(regions.map(r => [r.code, Boolean(r.token)]))
  });
});

// ---------- Flow → Order created → Seal search ----------
/**
 * POST /flow/order-created
 * Body (exact Flow config you provided):
 * {
 *   "shopDomain": "{{shop.myshopifyDomain}}",
 *   "orderId": "{{order.id}}",
 *   "email": "{{order.email}}"
 * }
 * If you set a SEAL_SUBS_SECRET_* for that shop, include header:
 *   X-Flow-Secret: <matching secret>
 */
app.post('/flow/order-created', async (req, res) => {
  try {
    const { shopDomain, orderId, email } = req.body || {};

    if (!shopDomain || !isValidShop(shopDomain)) {
      return errRes(res, 400, 'Missing/invalid shopDomain', shopDomain);
    }
    const region = byShop.get(shopDomain);
    if (!region) return errRes(res, 400, `Shop not recognized: ${shopDomain}`);

    // optional shared-secret check
    if (region.secret && !tscEq(req.header('X-Flow-Secret'), region.secret)) {
      return errRes(res, 401, 'Bad X-Flow-Secret');
    }

    if (!email) return errRes(res, 400, 'Missing email');
    if (!region.token) return errRes(res, 500, 'Seal token not configured for shop', region.code);

    // Seal search by email (Seal docs: /subscriptions?query=<term>)
    const url = `https://app.sealsubscriptions.com/shopify/merchant/api/subscriptions?query=${encodeURIComponent(email)}&active-only=false&page=1`;
    const r = await timedFetch(url, {
      headers: { 'X-Seal-Token': region.token, 'Accept': 'application/json' }
    });
    const text = await r.text();
    if (!r.ok) return errRes(res, r.status, 'Seal search error', text.slice(0, 500));

    // API may return an array or { payload: [...] }
    const parsed = safeJson(text) ?? {};
    const items = Array.isArray(parsed) ? parsed : (parsed.payload ?? []);

    // Return raw Seal payloads; Flow will handle selecting fields & tagging next.
    return res.json({
      ok: true,
      shopDomain,
      orderId,
      email,
      count: items.length,
      subscriptions: items
    });
  } catch (e) {
    console.error('flow/order-created error', e);
    return errRes(res, 500, 'Server error', e.stack || String(e));
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Seal-only proxy listening on :${port}`);
});
