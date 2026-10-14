# Design

## Context

See proposal.md. Current state: bare Nest scaffold. Two in-flight changes define what this one builds on: `add-catalog-persistence` (customers, catalogs with versioned, described schemas, sites) and `add-queued-scrape-execution` (the selector-spec format, the fixed runner with preview limits and transforms, queue and results-queue pattern, worker outside the VPC with no database access). Customers are external and their sites and page text are untrusted; every attempt costs money (POC budgets come in a later change); discovery produces *candidates* that a customer previews and activates in yet another change. AWS is the target. The PRD fixes Claude Agent SDK driving the Puppeteer MCP.

## Goals / Non-Goals

**Goals:**
- Turn a site URL plus the catalog schema snapshot into a verified candidate selector spec, or a clear reason why not.
- Never trust the model's claim: anything offered has been run against the live site with the production runner.
- Contain a hostile site or prompt injection: restricted tools, confined browsing, no database or cross-customer access.
- Bound cost per attempt and leave a hook for budgets.

**Non-Goals:**
- The customer-facing flow (sample approval, retry UX, activation, clearing markers) and authentication.
- The budget ledger and quotas, notifications.
- Structured-data sources (JSON-LD, internal APIs) as extraction types; the spec vocabulary is CSS/XPath only for now.

## Decisions

**1. Same async shape as scraping: API creates the record, queue carries the work, worker has no database access, results queue returns the outcome.** The message carries the site URL, schema snapshot, mode, base spec key, guidance and caps. The worker writes the candidate and evidence to S3 and sends `{attemptId, outcome, reason, candidateKey, evidenceKey, usage}`; the API finalizes (attempt record, spec version number, schema-still-matches check). A compromised or confused worker therefore cannot read other customers' data or reach PostgreSQL. Alternative: the worker writes to the database directly; needs VPC reach and widens the blast radius.

**2. Runtime: ECS Fargate service reading the discovery queue, scaled by queue depth between 0 and 2 tasks.** Discovery runs for minutes, spawns Chromium, an MCP server and the agent process, which does not suit Lambda. Each task handles one message at a time with a visibility-timeout heartbeat, uses a fresh browser profile per attempt and cleans its temp directory. Alternatives: EventBridge Pipes to `RunTask` per attempt (strong isolation, but the 2-worker cap needs separate enforcement); an always-on worker (idle cost). Scale-to-zero behavior of the autoscaling policy is to be confirmed during infrastructure tasks.

**3. Tool set is closed: the Puppeteer MCP plus an in-process MCP server with three spec tools.** `outline_page` returns a trimmed structural summary of the current page (so raw HTML never floods the context), `test_locator` returns match count and sample texts for a CSS selector or XPath, and `submit_spec` validates a candidate against the selector-spec schema and returns errors or accepts it. The agent has no shell, file or web-fetch tools (explicit allow-list in the SDK options). Alternative: give the agent general tools and trust the prompt; rejected because pages are attacker-controlled.

**4. Page content is untrusted by construction, not by instruction alone.** The prompt tells the agent to treat page text as data, but the guarantee comes from the limits: the only accepted output is a schema-validated spec through `submit_spec`; nothing the agent can call reaches customer data, the network beyond the site, or the database. Worst case for an injection is a bad candidate, which verification and the customer's preview catch.

**5. Browsing guard at the browser layer.** Puppeteer request interception on every request: allow only http(s); block top-level navigation outside the site's registrable domain and subdomains; resolve each request's host and block loopback, private, link-local (including `169.254.169.254` and the ECS task-metadata address) and reserved ranges, including on redirects; disable downloads and file/chrome schemes. The same IP-range check validates the site URL at request time (API) and again in the worker, which closes DNS-rebinding gaps by checking the connected address, not only the first lookup. Fargate task networking is additionally placed in subnets whose security group has no route to the database or other internal services. Alternative: rely only on network egress filtering (AWS Network Firewall); heavier and still needs the application check for the link-local addresses.

**6. Verification uses the production runner.** The worker image includes the runner library from `add-queued-scrape-execution`. After `submit_spec` accepts a candidate, the worker runs it in preview mode against the live site and applies the thresholds: a minimum item count, system fields on at least 95% of items, distinct absolute links, per-property parse rate at least 80% (the same parse rule as scrape completeness). Failure details go back to the agent for up to 3 repair rounds, counted against the attempt caps. Alternative: trust the agent's own `test_locator` checks; rejected, since passing there does not prove the full spec (pagination, transforms, variants) works.

**7. Unresolved is a valid outcome.** If a property cannot be found with confidence, it stays unbound and is listed with a reason. The PRD rule (leave out rather than guess) is preserved, and the customer can refine the property description and retry, or accept the partial result.

**8. Incremental mode is structural, not just prompted.** The candidate is accepted only if it equals the base spec plus new bindings (a structural diff, not a model promise), and verification compares existing properties' typed values with the base spec's on the same pages. Alternative: re-run full discovery to add a property; rejected because it can break working bindings and costs more.

**9. Caps and the admission hook.** Per-attempt caps (turns, duration, cost; defaults in configuration) are enforced by the worker through the SDK's limits and a wall-clock watchdog; usage is recorded in the result. A port `AdmissionPolicy` is called before queuing; the default implementation allows everything, and `add-usage-budgets` replaces it. Whether the SDK reports cost directly is to be verified; if not, usage is derived from token counts and a price table.

**10. Model access is configuration, leaning Amazon Bedrock.** The Agent SDK can be pointed at Bedrock (IAM role, one AWS bill, no API key secret) or the Anthropic API. The choice depends on model availability in the chosen region and is made in the infrastructure tasks. The worker code does not depend on it.

**11. Spec versions: immutable objects plus a record.** The API, not the worker, assigns the next per-site number inside a transaction (unique `(site_id, version)`), then writes `customers/{customerId}/sites/{siteId}/specs/{version}.json` with a conditional put and records source, attempt, schema version authored against and bound properties in `site_spec_versions`. Evidence lives at `customers/{customerId}/sites/{siteId}/discoveries/{attemptId}/` with the same retention treatment as raw results. Storing never activates anything; the active pointer belongs to the activation change (interim `active.json`).

**12. Locator stability is advisory.** The evidence flags positional chains, long absolute XPaths and hash-like class names. Failing on them would reject specs that work today; surfacing them helps the customer judge fragility and explains later breakage.

**13. Failures: deterministic stop, transient retry.** `unreachable_site`, `blocked_by_site`, `no_catalog_found`, `verification_failed`, `invalid_output`, `cap_exceeded`, `budget_exhausted` and `schema_changed` are final; infrastructure errors are redelivered up to 3 times, then go to the DLQ.

**14. Annotated screenshots are part of the evidence.** Passing verification shows that values parse, not that `price` is the current price rather than the struck-through one. After verification (pass or fail), the worker renders up to 3 sample pages (the listing page, plus a detail page when a binding is read from one) with an overlay injected only for the capture: each bound element is outlined and labelled with its property name. Images are stored with the rest of the evidence under the owner prefix and the same retention. Doing it after verification keeps the overlay from touching extraction. Alternative: rely on the text sample rows alone; rejected, because the customer's approval decision is much faster and more reliable when they can see which element was chosen.

**15. Repair is a third mode, because the recurring event is partial breakage.** A site redesign typically breaks a few bindings, not all. `full` can rewrite bindings that work and `incremental` cannot touch broken ones. `repair` takes the active spec as its base, targets bound properties (named by the caller, or defaulted from the properties the latest scrape reported as failing), and accepts a candidate only if it equals the base with just those bindings replaced or removed. It reuses the incremental structural diff and regression check, so there is one mechanism for "change only these bindings". Properties that cannot be re-located are omitted and reported, never guessed; if nothing is repaired the attempt fails. Broken system fields (item container, link) are out of scope for repair and go to `full`. Repair is still only run when requested; automatic re-discovery stays dropped. Alternative: let `full` handle all breakage; rejected because it puts working bindings at risk and costs more.

## Risks / Trade-offs

- [Cost per attempt is unpredictable] → hard caps, recorded usage, the admission hook, and repair rounds counted against caps.
- [The model produces plausible but wrong selectors] → live verification with the production runner, evidence samples, and the customer's preview before activation.
- [Sites block AWS datacenter IPs or detect headless browsers] → `blocked_by_site` is a first-class outcome; smoke-test the five dev sites early; no evasion techniques are in scope.
- [Prompt injection or hostile pages steer the agent] → closed tool set, validated-only output, confined browsing, no database or cross-customer access from the worker.
- [SSRF through redirects or DNS rebinding] → checks on the connected address at every request plus subnet-level isolation.
- [Scale-to-zero autoscaling on queue depth has start-up lag] → acceptable for an asynchronous flow; revisit if latency matters.
- [The default repair targets depend on what the scrape change records about failing properties] → the repair task reads whatever `add-queued-scrape-execution` stores (parse anomalies, mismatches); if that is too coarse, callers name the properties explicitly.
- [Screenshots add storage and contain third-party page content] → capped count and dimensions, private to the owning customer, same retention as other evidence.
- [Page outlines hide information the agent needs] → the browser tools remain available for deeper inspection; outline size is a tunable.
- [Legal and terms-of-service exposure of scraping third-party sites on customers' behalf] → outside this design, but flagged for the product owner before onboarding external prospects.

## Migration Plan

Nothing is deployed. Order: attempt and version tables and records; the request endpoint with URL safety and admission port; the spec tools and verifier against saved fixtures; the browsing guard; the agent worker locally against the five dev sites; the queue, service and finalizer; evidence and usage; then AWS deployment. Rollback: scale the service to zero and stop accepting requests; stored specs and attempts are inert.

## Open Questions

- Default caps (turns, minutes, cost) and the minimum item count for verification; tune after real attempts.
- Whether the SDK exposes per-run cost, which decides how usage is recorded.
- Bedrock versus the Anthropic API, once region and model availability are checked.
