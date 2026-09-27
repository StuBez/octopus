import { cashAssert, cashBinding, cashDigest, cashObject, cashTime } from "./marketing-cash-compare";
import { resolveMarketingConfig } from "./marketing-conversions";
import { auditUpstreamCash, UPSTREAM_LIMITS, validateUpstreamInput, type AuditInput, type AuditPins } from "./marketing-upstream-audit";

export type StripeAuditFetch = (url: string, init: RequestInit) => Promise<Response>;

export const TRANSPORT_FRESH_MS = 15 * 60_000;
export type UpstreamAuthority = {
  expectedPins: AuditPins;
  issuedAt: string;
  expiresAt: string;
};

/** Pure offline plan. Authority is an independently retained owner artifact, never a provider response. */
export function planUpstreamTransport(input: AuditInput, authority: UpstreamAuthority, evidenceDirectory: string, now = Date.now()) {
  cashObject(authority, ["expectedPins", "issuedAt", "expiresAt"]);
  const retained = validateUpstreamInput(input, now);
  // Exact JSON contract: field order is deliberately retained, not silently normalized.
  cashAssert(JSON.stringify(authority.expectedPins) === JSON.stringify(input.pins));
  const issued = Date.parse(cashTime(authority.issuedAt)), expires = Date.parse(cashTime(authority.expiresAt));
  cashAssert(issued <= now && expires > now && expires - issued <= TRANSPORT_FRESH_MS);
  cashAssert(now - Date.parse(String(retained.retainedObservation.completedAt)) <= TRANSPORT_FRESH_MS);
  cashAssert(typeof evidenceDirectory === "string" && evidenceDirectory.startsWith("/") && evidenceDirectory.length <= 1024 && !/[\x00-\x1f]/.test(evidenceDirectory));
  const p = input.pins;
  const query = `created[gte]=${Math.floor(Date.parse(p.from) / 1000)}&created[lt]=${Math.ceil(Date.parse(p.to) / 1000)}&limit=100`;
  const plan = {
    contract: "upstream-cash-transport/v1", inputDigest: cashDigest(JSON.stringify(input)),
    authorityDigest: cashDigest(JSON.stringify(authority)), evidenceDirectory,
    from: p.from, to: p.to, activationFrom: p.activationFrom, expiresAt: authority.expiresAt,
    method: "GET", origin: "https://api.stripe.com", apiVersion: p.apiVersion,
    initialEndpoints: ["/v1/account", `/v1/charges?${query}`, `/v1/refunds?${query}`],
    dependencies: ["/v1/payment_intents/{exact observed payment}", "/v1/charges/{exact refund original}", "/v1/refunds/{exact observed refund}", "/v1/checkout/sessions?payment_intent={exact observed payment}&limit=2"],
    pagination: "starting_after only, within the same declared list bounds",
    originalDependency: "Exact refund original may predate activation; no historical list sweep",
    limits: UPSTREAM_LIMITS, automaticRetries: 0,
    A: "not_observed", C: "unknown", evidence: "local exclusive files; not database immutability",
  };
  const body = JSON.stringify(plan);
  return { body, digest: cashDigest(body) };
}

/** Credential access matches the existing server runtime. No SDK retries, DB imports or new keys. */
export function upstreamRuntimeGuards(input: AuditInput, env: Record<string, string | undefined>) {
  const config = resolveMarketingConfig(env); cashAssert(config);
  const binding = cashBinding(config, env.UNIFIED_ADS_CASH_EXPECTED_BINDING);
  cashAssert(JSON.stringify(binding) === JSON.stringify(input.pins.binding) && config.from.toISOString() === input.pins.activationFrom);
  const key = env.STRIPE_SECRET_KEY;
  cashAssert(typeof key === "string" && new RegExp(`^(sk|rk)_${input.pins.environment}_[A-Za-z0-9]+$`).test(key));
  return key;
}

/** Private credential-bearing boundary. Only the audit calls it; request authority is checked twice. */
export function stripeAuditTransport(input: AuditInput, key: string, send: StripeAuditFetch, now = () => Date.now(), expiresAt = Infinity) {
  const start = now(); let calls = 0;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), q = url.searchParams;
      cashAssert(now() < expiresAt && now() - start < UPSTREAM_LIMITS.overallMs && ++calls <= UPSTREAM_LIMITS.reads);
      cashAssert(request.method === "GET" && request.body === null && request.redirect === "error" && !request.signal.aborted);
      cashAssert(url.origin === "https://api.stripe.com" && !url.username && !url.password && !url.hash);
      cashAssert(JSON.stringify([...request.headers.keys()].sort()) === JSON.stringify(["accept", "stripe-version"]));
      cashAssert(request.headers.get("accept") === "application/json" && request.headers.get("stripe-version") === input.pins.apiVersion);
      cashAssert(new Set(q.keys()).size === [...q.keys()].length);
      if (url.pathname === "/v1/charges" || url.pathname === "/v1/refunds") {
        cashAssert([...q.keys()].every(k => ["created[gte]", "created[lt]", "limit", "starting_after"].includes(k)));
        cashAssert(q.get("created[gte]") === String(Math.floor(Date.parse(input.pins.from) / 1000)) && q.get("created[lt]") === String(Math.ceil(Date.parse(input.pins.to) / 1000)) && q.get("limit") === "100");
        const cursor = q.get("starting_after");
        cashAssert(cursor === null || (url.pathname === "/v1/charges" ? /^(ch|py)_[A-Za-z0-9]+$/ : /^(re|pyr)_[A-Za-z0-9]+$/).test(cursor));
      } else if (url.pathname === "/v1/checkout/sessions") {
        cashAssert(q.size === 2 && q.get("limit") === "2" && /^pi_[A-Za-z0-9]+$/.test(q.get("payment_intent") ?? ""));
      } else {
        cashAssert(q.size === 0 && /^\/v1\/(account|payment_intents\/pi_[A-Za-z0-9]+|charges\/(ch|py)_[A-Za-z0-9]+|refunds\/(re|pyr)_[A-Za-z0-9]+)$/.test(url.pathname));
      }
      const headers = new Headers(request.headers); headers.set("Authorization", `Bearer ${key}`);
      const response = await send(url.href, { method: "GET", headers, cache: "no-store", redirect: "error", credentials: "omit", signal: request.signal });
      cashAssert(!response.redirected && (!response.url || response.url === request.url) && !(response.status >= 300 && response.status < 400));
      return response;
    } catch {
      // Never expose a fetch/SDK exception containing a URL, credential or provider body.
      throw new Error("upstream_transport_stopped_no_retry");
    }
  };
}

/** Explicit invocation only. Tests inject a synthetic transport; import/build performs no IO. */
export async function executeUpstreamTransport(input: AuditInput, authority: UpstreamAuthority, evidenceDirectory: string, approvedPlanDigest: string, env: Record<string, string | undefined>, send: StripeAuditFetch, now = () => Date.now()) {
  const plan = planUpstreamTransport(input, authority, evidenceDirectory, now());
  cashAssert(/^[0-9a-f]{64}$/.test(approvedPlanDigest) && plan.digest === approvedPlanDigest);
  const key = upstreamRuntimeGuards(input, env);
  const result = await auditUpstreamCash(input, stripeAuditTransport(input, key, send, now, Date.parse(authority.expiresAt)), { now });
  return { ...result, planDigest: plan.digest };
}
