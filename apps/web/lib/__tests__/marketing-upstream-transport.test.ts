import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeUpstreamTransport, planUpstreamTransport, stripeAuditTransport, type StripeAuditFetch, type UpstreamAuthority } from "../marketing-upstream-transport";
import { runOperator } from "../../scripts/marketing-upstream-transport";
import { upstreamFixture } from "./fixtures/marketing-upstream";

async function setup() {
  const f = await upstreamFixture();
  const authority: UpstreamAuthority = { expectedPins: structuredClone(f.input.pins), issuedAt: new Date(f.now - 100).toISOString(), expiresAt: new Date(f.now + 60_000).toISOString() };
  const env = { STRIPE_SECRET_KEY: "sk_test_synthetic", UNIFIED_ADS_ENABLED: "true", UNIFIED_ADS_SOURCE_ID: f.input.pins.binding.sourceId, UNIFIED_ADS_ENVIRONMENT: "test", UNIFIED_ADS_SERVER_KEY: `uads_${f.input.pins.binding.keyId}_${"x".repeat(43)}`, UNIFIED_ADS_FROM: f.input.pins.activationFrom, UNIFIED_ADS_CASH_EXPECTED_BINDING: JSON.stringify(f.input.pins.binding) };
  const plan = () => planUpstreamTransport(f.input, authority, "/synthetic/evidence", f.now);
  const run = (send: StripeAuditFetch = (url, init) => { expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error"); return f.send(new Request(url, init)); }) => executeUpstreamTransport(f.input, authority, "/synthetic/evidence", plan().digest, env, send, () => f.now);
  return { ...f, authority, env, plan, run };
}

describe("explicit upstream real-transport candidate (synthetic IO only)", () => {
  it("plans without credentials or IO, then executes canonical GET audit with separate A/B/C", async () => {
    const f = await setup();
    expect(f.requests).toHaveLength(0);
    expect(JSON.parse(f.plan().body).initialEndpoints).toHaveLength(3);
    const result = await f.run(); const body = JSON.parse(result.body);
    expect(body.members.map((m: { semanticDigest: string }) => m.semanticDigest).sort()).toEqual(f.retained.members.map(m => m.semanticDigest).sort());
    expect([body.A, body.B, body.C]).toEqual(["not_observed", "complete_retained_scope", "unknown"]);
    expect(body.captureAgreement).toBe("matched_for_observed_scope");
    expect(f.requests).toHaveLength(5);
    for (const request of f.requests) {
      expect(request.method).toBe("GET"); expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_synthetic");
      expect(request.headers.has("cookie") || request.headers.has("origin") || request.headers.has("stripe-account")).toBe(false);
    }
    for (const secret of [f.env.STRIPE_SECRET_KEY, f.env.UNIFIED_ADS_SERVER_KEY, "cus_fixture", "org_fixture"]) expect(result.body + f.plan().body).not.toContain(secret);
  });

  it("fails independent binding, approval, stale inventory and runtime guards before IO", async () => {
    for (const kind of ["expected", "digest", "expired", "stale", "key", "source", "project", "activation", "retained"] as const) {
      const f = await setup(); const approved = f.plan().digest;
      if (kind === "expected") f.authority.expectedPins.accountId = "acct_wrong";
      if (kind === "digest") f.input.pins.predecessorDigest = "a".repeat(64);
      if (kind === "expired") f.authority.expiresAt = new Date(f.now - 1).toISOString();
      if (kind === "key") f.env.STRIPE_SECRET_KEY = "sk_live_wrong";
      if (kind === "source") f.env.UNIFIED_ADS_SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      if (kind === "project") f.env.UNIFIED_ADS_CASH_EXPECTED_BINDING = JSON.stringify({ ...f.input.pins.binding, project: { ...f.input.pins.binding.project, version: 2 } });
      if (kind === "activation") f.env.UNIFIED_ADS_FROM = new Date(f.now).toISOString();
      if (kind === "retained") f.input.retainedBody += " ";
      let tick = f.now;
      if (kind === "stale") { tick += 900_001; f.authority.issuedAt = new Date(tick - 1).toISOString(); f.authority.expiresAt = new Date(tick + 60_000).toISOString(); }
      await expect(executeUpstreamTransport(f.input, f.authority, "/synthetic/evidence", approved, f.env, (url, init) => f.send(new Request(url, init)), () => tick)).rejects.toThrow();
      expect(f.requests).toHaveLength(0);
    }
  });

  it("denies non-GET, foreign origin, redirects, credentials, headers, query expansion and expired plans", async () => {
    const f = await setup(); let calls = 0;
    const send = async () => { calls++; return Response.json({}); };
    const base = { method: "GET", redirect: "error" as const, credentials: "omit" as const, headers: { Accept: "application/json", "Stripe-Version": f.input.pins.apiVersion } };
    const transport = stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, send, () => f.now);
    const bad = [
      new Request("https://api.stripe.com/v1/account", { ...base, method: "POST" }),
      new Request("https://evil.example/v1/account", base),
      new Request("https://api.stripe.com/v1/account", { ...base, redirect: "follow" }),
      new Request("https://api.stripe.com/v1/account", { ...base, headers: { ...base.headers, Cookie: "synthetic" } }),
      new Request("https://api.stripe.com/v1/account?expand[]=external_accounts", base),
      new Request("https://api.stripe.com/v1/charges?limit=100", base),
      new Request("https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_fixture&limit=2&limit=2", base),
    ];
    for (const r of bad) await expect(transport(r)).rejects.toThrow("upstream_transport_stopped_no_retry");
    const request = new Request("https://api.stripe.com/v1/account", base);
    await expect(stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, send, () => f.now, f.now)(request)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, async () => { calls++; return new Response(null, { status: 302, headers: { Location: "https://evil.example" } }); })(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("keeps rate limits, redirect and ambiguous network failures partial without retry or raw exception leakage", async () => {
    for (const kind of ["rate", "redirect", "network"] as const) {
      const f = await setup(); let calls = 0;
      const result = await f.run(async () => { calls++; if (kind === "network") throw Error("sk_test_PRIVATE_PROVIDER_BODY"); return new Response(null, { status: kind === "rate" ? 429 : 302 }); });
      const p = JSON.parse(result.body);
      expect(calls).toBe(1); expect(p.processorEnumeration).toBe("partial"); expect(p.C).toBe("unknown"); expect(p.captureAgreement).toBe("incomplete");
      expect(result.body).not.toContain("PRIVATE_PROVIDER_BODY");
    }
  });

  it("writes durable intent before IO and refuses a second invocation in the same evidence directory", async () => {
    const f = await setup(); const directory = await mkdtemp(join(tmpdir(), "upstream-operator-"));
    try {
      const inputPath = join(directory, "input.json"), authorityPath = join(directory, "authority.json"), output = join(directory, "evidence");
      await writeFile(inputPath, JSON.stringify(f.input)); await writeFile(authorityPath, JSON.stringify(f.authority));
      let calls = 0;
      const send: StripeAuditFetch = async (url, init) => { calls++; const intent = JSON.parse(await readFile(join(output, "intent.json"), "utf8")); expect(intent.plan.inputDigest).toBeTruthy(); return f.send(new Request(url, init)); };
      const plan = await runOperator(["plan", inputPath, authorityPath, output], {}, send, () => f.now);
      expect(calls).toBe(0);
      await runOperator(["execute", inputPath, authorityPath, output, plan.digest], f.env, send, () => f.now);
      expect(calls).toBe(5);
      const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8")); expect(receipt.planDigest).toBe(plan.digest);
      const result = await readFile(join(output, "result.json"), "utf8"); expect(result).not.toContain(f.env.STRIPE_SECRET_KEY);
      await expect(runOperator(["execute", inputPath, authorityPath, output, plan.digest], f.env, send, () => f.now)).rejects.toThrow();
      expect(calls).toBe(5);
    } finally { await rm(directory, { recursive: true }); }
  });
});
