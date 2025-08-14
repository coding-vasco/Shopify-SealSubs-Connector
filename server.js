import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';

// ----- config & helpers -----
const {
  SHOP_DOMAIN_UK, SHOP_DOMAIN_EU, SHOP_DOMAIN_US,
  SEAL_SUBS_TOKEN_UK, SEAL_SUBS_TOKEN_EU, SEAL_SUBS_TOKEN_US,
  SEAL_SUBS_SECRET_UK, SEAL_SUBS_SECRET_EU, SEAL_SUBS_SECRET_US,
  SHOPIFY_ACCESS_TOKEN_UK, SHOPIFY_ACCESS_TOKEN_EU, SHOPIFY_ACCESS_TOKEN_US,
  SHOPIFY_ADMIN_API_VERSION = '2025-07',
} = process.env;

const regions = [
  { code: 'UK', shop: SHOP_DOMAIN_UK, sealToken: SEAL_SUBS_TOKEN_UK, flowSecret: SEAL_SUBS_SECRET_UK, shopifyToken: SHOPIFY_ACCESS_TOKEN_UK },
  { code: 'EU', shop: SHOP_DOMAIN_EU, sealToken: SEAL_SUBS_TOKEN_EU, flowSecret: SEAL_SUBS_SECRET_EU, shopifyToken: SHOPIFY_ACCESS_TOKEN_EU },
  { code: 'US', shop: SHOP_DOMAIN_US, sealToken: SEAL_SUBS_TOKEN_US, flowSecret: SEAL_SUBS_SECRET_US, shopifyToken: SHOPIFY_ACCESS_TOKEN_US },
].filter(r => r.shop);

const byShop = new Map(regions.map(r => [r.shop, r]));
const isValidShop = (s) => /^[a-z0-9-]+\.myshopify\.com$/.test(s);

// constant-time compare
const tscEquals = (a, b) => {
  const A = Buffer.from(String(a) || '', 'utf8');
  const B = Buffer.from(String(b) || '', 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

const app = express();
app.use(express.json({ limit: '200kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    shops: regions.map(r => r.shop),
    sealConfigured: regions.map(r => ({ [r.code]: Boolean(r.sealToken) })),
    shopifyConfigured: regions.map(r => ({ [r.code]: Boolean(r.shopifyToken) }))
  });
});

/**
 * Flow → POST /flow/order-created
 * Body (recommended in Flow):
 * {
 *   "shopDomain": "{{shop.domain}}",
 *   "orderId": "{{order.id}}",
 *   "orderName": "{{order.name}}",
 *   "customerId": "{{order.customer.id}}",
 *   "email": "{{order.email}}"
 * }
 * Headers:
 *   Content-Type: application/json
 *   X-Flow-Secret: <region-specific secret>   # set per shop
 */
app.post('/flow/order-created', async (req, res) => {
  try {
    const { shopDomain, orderId, orderName, customerId, email } = req.body || {};
    if (!shopDomain || !isValidShop(shopDomain)) {
      return res.status(400).json({ error: 'Missing or invalid shopDomain' });
    }
    const region = byShop.get(shopDomain);
    if (!region) return res.status(400).json({ error: `Shop not recognized: ${shopDomain}` });

    // Optional shared-secret check (recommended)
    const secretHdr = req.header('X-Flow-Secret');
    if (region.flowSecret && !tscEquals(secretHdr, region.flowSecret)) {
      return res.status(401).json({ error: 'Bad X-Flow-Secret' });
    }

    if (!region.sealToken) return res.status(500).json({ error: 'Seal token not configured for shop' });
    if (!region.shopifyToken) return res.status(500).json({ error: 'Shopify token not configured for shop' });

    // 1) Ensure we have email + IDs (fallback to Admin API if Flow didn't send them)
    const ensured = await ensureOrderContext({
      shopDomain, orderId, orderName, customerId, email
    }, region.shopifyToken);

    if (!ensured.orderId) return res.status(400).json({ error: 'orderId (gid) required or resolvable' });
    if (!ensured.email) return res.status(400).json({ error: 'email required (send via Flow or resolvable from order)' });

    // 2) Seal: search subscriptions by email (paginate once; adjust as needed)
    const subs = await sealSearchByEmail(ensured.email, region.sealToken);

    // 3) For each subscription, fetch details to get billing_min_cycles
    const details = await Promise.all(
      subs.map(s => sealGetById(s.id, region.sealToken))
    );

    // Pick minimal fields & build tags
    const minimal = details.map(d => ({
      id: d.id,
      billing_min_cycles: d.billing_min_cycles ?? null
    }));

    const tags = [
      ...minimal.map(m => `seal_sub_id_${m.id}`),
      ...minimal.filter(m => m.billing_min_cycles != null).map(m => `seal_min_cycles_${m.billing_min_cycles}`)
    ];

    // 4) Tag order + customer (if provided/resolved)
    const tagResults = {};
    try {
      tagResults.order = await tagsAdd(shopDomain, region.shopifyToken, ensured.orderId, tags);
    } catch (e) {
      tagResults.order = { error: e.message || 'order tagging failed' };
    }
    if (ensured.customerId) {
      try {
        tagResults.customer = await tagsAdd(shopDomain, region.shopifyToken, ensured.customerId, tags);
      } catch (e) {
        tagResults.customer = { error: e.message || 'customer tagging failed' };
      }
    }

    return res.json({
      ok: true,
      shopDomain,
      orderId: ensured.orderId,
      orderName: ensured.orderName,
      customerId: ensured.customerId || null,
      email: ensured.email,
      subscriptions: minimal,
      tagResults
    });
  } catch (err) {
     console.error('flow/order-created error', err);
     const body = { error: 'Server error' };
     if (process.env.DEBUG_ERRORS === 'true') {
       body.details = String(err?.message || err);
       body.stack = (err?.stack || '').split('\n').slice(0,3);
     }
     return res.status(500).json(body);
  }
});

// ----- Seal helpers -----
async function sealSearchByEmail(email, sealToken) {
  const url = `https://app.sealsubscriptions.com/shopify/merchant/api/subscriptions?query=${encodeURIComponent(email)}&active-only=false&page=1`;
  const resp = await fetch(url, { headers: { 'X-Seal-Token': sealToken, 'Accept': 'application/json' } });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Seal search failed ${resp.status}: ${text.slice(0,300)}`);
  const data = safeJson(text);
  return Array.isArray(data) ? data : (data?.payload ?? []);
}

async function sealGetById(id, sealToken) {
  const url = `https://app.sealsubscriptions.com/shopify/merchant/api/subscription?id=${encodeURIComponent(id)}`;
  const resp = await fetch(url, { headers: { 'X-Seal-Token': sealToken, 'Accept': 'application/json' } });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Seal get failed (${id}) ${resp.status}: ${text.slice(0,300)}`);
  const json = safeJson(text);
  // Some responses wrap in { success, payload }
  return json?.payload || json;
}

  function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }

// ----- Shopify helpers -----
async function ensureOrderContext({ shopDomain, orderId, orderName, customerId, email }, shopifyToken) {
  if (orderId && customerId && email && orderName) {
    return { shopDomain, orderId, orderName, customerId, email };
  }

  // If orderId missing but orderName present, look it up
  if (!orderId && orderName) {
    const found = await findOrderByName(shopDomain, shopifyToken, orderName);
    orderId = found?.id || orderId;
    customerId = found?.customer?.id || customerId;
    email = found?.email || email;
    orderName = found?.name || orderName;
  }

  // If still missing email or customer, fetch by id
  if ((!email || !customerId || !orderName) && orderId) {
    const got = await getOrderById(shopDomain, shopifyToken, orderId);
    orderName = got?.name || orderName;
    email = email || got?.email || got?.customer?.email || null;
    customerId = customerId || got?.customer?.id || null;
  }

  return { shopDomain, orderId, orderName, customerId, email };
}

async function findOrderByName(shop, token, orderName) {
  const q = `name:${orderName.startsWith('#') ? orderName : '#' + orderName}`;
  const query = `
    query($q: String!) {
      orders(first: 1, query: $q) {
        nodes { id name email customer { id } }
      }
    }`;
  const resp = await shopifyGraphQL(shop, token, query, { q });
  return resp?.orders?.nodes?.[0] || null;
}

async function getOrderById(shop, token, orderId) {
  const query = `
    query($id: ID!) {
      order(id: $id) { id name email customer { id } }
    }`;
  const resp = await shopifyGraphQL(shop, token, query, { id: orderId });
  return resp?.order || null;
}

async function tagsAdd(shop, token, gid, tags) {
  if (!tags?.length) return { skipped: 'no tags to add' };
  const mutation = `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id tags }
        userErrors { field message }
      }
    }`;
  const r = await shopifyGraphQL(shop, token, mutation, { id: gid, tags: Array.from(new Set(tags)) });
  return r?.tagsAdd || r;
}

async function shopifyGraphQL(shop, token, query, variables) {
  const resp = await fetch(`https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    const msg = json.errors ? JSON.stringify(json.errors) : `status ${resp.status}`;
    throw new Error(`Shopify GraphQL failed: ${msg}`);
  }
  return json.data;
}

// ----- start -----
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Seal Flow Proxy listening on :${port}`));
