# Isolated upstream cash audit candidate

This explicitly invoked audit is separate from capture and dispatch. It has no
default transport, credentials, database client, receiver client or scheduler.
The supplied command reads a synthetic transcript only. It cannot contact Stripe.
No production use or upstream completeness acceptance is implied by this candidate.

```sh
bun apps/web/scripts/marketing-upstream-audit.ts /new/path/result.json < fixture.json
```

The result path must not exist. It is created exclusively with mode 0600 and
flushed; this is local retained evidence, not database immutability. Retain its
printed SHA-256 separately. Never put credentials in the transcript. The driver
rejects LIVE fixtures and consumes stdin up to 8 MiB. Failures are not retried.

## Input and observation boundary

`AuditInput` pins account, environment, API version `2026-06-24.dahlia`, canonical
UTC activation and `[from,to)` timestamps, independently retained expected receiver
source/key/project/version/capabilities, ownership projection digest, exact retained
inventory body digest and nullable predecessor digest. `transportBinding` is a
separately retained expectation; an object response does not prove credential mode.
`ownership` contains retained organization/customer pairs, not a customer scan.
`retainedBody` is the exact sealed `retained-cash/v1` inventory for that interval.
No source selection is inferred from processor results. QA classifications are
neither rewritten nor interpreted as cash exclusions.

The transcript adds a synthetic `now` and ordered `responses` of exact GET `url`,
HTTP `status` and JSON `body`. Responses must cover account identity, independent
charge and refund lists, and only the exact payment/charge/checkout dependencies
needed by in-range objects. No authorization headers or network are used. Lists
are independent of retained ledger membership. Original-payment dependencies may
precede activation; they retain their actual timestamps and do not trigger capture.

The core enforces 100 objects/page, 10 pages/list endpoint, 500 total reads,
10 seconds/read and five minutes overall with zero retries. Invalid input or
authority pins reject before any read. Page, read, deadline, identity or HTTP
failures during observation produce partial evidence; an oversized final packet
is rejected. Transcript mismatches or unused responses also reject without writing
a result. Each read has its own times;
list exhaustion is not an atomic processor snapshot. The fixture clock does not
turn local tests into real provider or temporal acceptance.

## Output schema `upstream-cash-audit/v1`

The packet contains pins (account hashed), limits, observation times, per-read
request digests/status/request IDs, page cursor/count/exhaustion and projection
digests, sanitized processor projections, dispositions, gaps and canonical members.
Raw customer, organization and processor object IDs are hashed. Canonical members
reuse `resolveStripeConversion`, `serializeConversion` and
`normalizeMarketingCash`; they carry semantic digest, original-payment relation,
exact occurrence, dependency flag, retained receipt and ledger aliases.

- A stays `not_observed`: no receiver comparison occurs here.
- B copies the sealed retained inventory's bounded assessment, not upstream coverage.
- C stays `unknown` in every result.
- `processorEnumeration` describes only exhaustion of declared account/time lists.
- `captureAgreement` can match only the observed supported scope without gaps.

Failed or canceled candidates retain a terminal disposition after identity,
ownership, customer and mode checks, before the latest-charge capture check.
An earlier failed attempt therefore does not make a later successful charge a
multiple-capture gap. Successful candidates still require the capture checks.

A successful processor fact missing ledger remains
`missing_ledger_activation_unresolved`. Unknown ownership, manual/multiple capture,
unsupported currency, alias conflicts, pending refunds, missing retained evidence
and delivery discrepancies remain gaps. An empty ledger or outbox is not evidence
of no cash. There is no customer-zero, learning admission, paid-causality, settlement
or whole-history completeness claim. Charge creation-time enumeration cannot by
itself prove capture-time completeness for unsupported delayed capture paths.

Late facts require a new packet with a new knowledge time and the old digest as
`predecessorDigest`; the earlier file remains unchanged. A later refund success
retains its original creation timestamp and may require an explicitly scoped
overlapping successor interval. No historical sweep runs automatically.

## New receiver fixture needs (not provisioned)

Root owns setup and cleanup after reviewing exact source and driver hashes. Supply
only synthetic retained inventory, independently expected TEST binding, ownership
projection and bounded processor transcript. Include CS/PI aliases, a purchase and
individual refunds, a pre-interval original dependency, missing ledger, lost ACK,
pending-to-success and unsupported cases. Receiver comparison, if separately
authorized, must use a new fixture and keep its observation times and A assessment
separate. This driver needs no backend key and sends no ingestion or comparison.
