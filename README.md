# Seal → Shopify Flow Proxy

**What it does**
- Receives **Shopify Flow → Order created** POST.
- Uses **Seal Merchant API** to fetch subscription(s) for the order’s customer (by email).
- Extracts `id` and `billing_min_cycles` and **tags the order and customer** with:
  - `seal_sub_id_<ID>`
  - `seal_min_cycles_<N>`

**Why proxy?**
- Keeps **Seal tokens** out of Flow, centralizes logic for UK/EU/US, handles retries and tagging in one hop.

## 1) Configure Render env
- Set all envs from `.env.example` (UK/EU/US shops, **SEAL_SUBS_TOKEN_***, **SEAL_SUBS_SECRET_*** (optional), and **SHOPIFY_ACCESS_TOKEN_***).
- Deploy. Check `GET /health`.

## 2) Create a Flow per shop
Trigger: **Order created** → Action: **Send HTTP request**  
- **Method:** POST  
- **URL:** `https://YOUR-RENDER/flow/order-created`  
- **Headers:**  
  - `Content-Type: application/json`  
  - `X-Flow-Secret: <the region’s SEAL_SUBS_SECRET_*>` *(optional but recommended)*  
- **Body (JSON):**
```json
{
  "shopDomain": "{{shop.domain}}",
  "orderId": "{{order.id}}",
  "orderName": "{{order.name}}",
  "customerId": "{{order.customer.id}}",
  "email": "{{order.email}}"
}
