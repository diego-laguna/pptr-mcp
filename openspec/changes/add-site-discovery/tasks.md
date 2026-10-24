# Tasks

## 1. Attempts, versions and URL safety

- [x] 1.1 Add the migration for `discovery_attempts` (mode, targeted properties, pinned schema version and snapshot, status, reason, spec version, usage, timestamps) with a partial unique index for one queued or running attempt per site, and `site_spec_versions` (unique `(site_id, version)`); verify integration tests refuse a second pending attempt and a duplicate version
- [x] 1.2 Implement the site URL safety check (scheme, no credentials, all resolved addresses public, loopback, private, link-local including `169.254.169.254` and reserved ranges rejected); verify unit tests cover each scenario in the discovery-requests spec including IPv6 and hostnames that resolve to private addresses
- [x] 1.3 Implement the request endpoint `POST /internal/sites/{siteId}/discoveries` (full, incremental and repair, guidance limit, `404`, `409 no_base_spec`, `422`, duplicate returns the existing attempt, `202` with `attemptId`); verify e2e tests for each case
- [x] 1.4 Implement the incremental and repair target resolution (incremental: default to all unbound properties, reject already-bound ones; repair: only bound properties, default to those the latest scrape reported failing, `422` when none, `409 no_base_spec` without an active spec) and the schema snapshot capture; verify unit tests including a description edited after the request not affecting the snapshot
- [x] 1.5 Add the `AdmissionPolicy` port with an allow-all default and the `429 budget_exhausted` rejection path; verify tests for a refusing policy and the default

## 2. Spec tools and verifier (pure and fixture-based)

- [x] 2.1 Implement the in-process spec tools: `outline_page` (trimmed structural summary with a size limit), `test_locator` (match count and sample texts for CSS or XPath) and `submit_spec` (schema validation returning errors); verify tests on saved HTML fixtures including an oversized page being truncated
- [x] 2.2 Implement the verifier on top of the runner library in preview mode with the thresholds (minimum items, system fields on 95% of items, distinct absolute links, per-property parse rate 80%); verify fixture tests for pass, low link coverage and low parse rate
- [x] 2.3 Implement the incremental checks (candidate equals base plus new bindings only; existing properties' typed values equal the base spec's on the same pages); verify tests for modified existing binding, regression and success
- [x] 2.3b Implement the repair checks on the same diff and regression machinery (candidate equals base with only targeted bindings replaced or removed; non-targeted values identical; each repaired binding meets the parse rate; nothing repaired fails; old-versus-new match count and parse rate in the evidence); verify tests for a changed system field or untargeted binding, a partly unresolved repair, nothing repaired and success
- [x] 2.4 Implement evidence assembly (up to 20 sample items with raw and typed values, match counts, parse rates, stability warnings, unresolved properties, guard events, notes) and the locator stability detector; verify tests for positional, long absolute and hash-like locators
- [x] 2.5 Implement the annotation renderer (inject an outline-and-label overlay for each bound element after verification, capture up to 3 pages with capped dimensions, list bindings with no match as "not highlighted"); verify on a saved HTML fixture that the expected outlines and labels appear, that unmatched bindings are reported, and that extracted values are identical with and without the capture

## 3. Discovery worker

- [ ] 3.1 Implement the browsing guard with request interception (scheme allow-list, top-level navigation confined to the site domain and subdomains, connected-address check for private and link-local ranges including redirects, downloads disabled); verify tests against a local server that redirects to internal addresses, another domain and a CDN
- [ ] 3.2 Configure the Agent SDK run: explicit tool allow-list (Puppeteer MCP plus the three spec tools, no shell, file or fetch tools), system prompt with the untrusted-content rule, schema snapshot and guidance, repair rounds limited to 3; verify a test that a denied tool request is refused and that free text without `submit_spec` yields no candidate
- [ ] 3.3 Implement caps (turns, duration watchdog, cost or token ceiling) and usage recording; verify a test with a stubbed model that exceeding each cap fails the attempt with `cap_exceeded` and preserves usage
- [ ] 3.4 Implement the worker entrypoint (read message, run, write candidate and evidence (including annotated screenshots) to S3 under the owner prefix, send the finished-attempt message, no database access, fresh browser profile and cleanup per attempt); verify with fakes that outcomes map to the failure reasons in the spec and that no database call occurs
- [ ] 3.5 Run the worker locally against two of the five dev sites with the real model and record outcomes, usage, unresolved properties and any blocking; verify the findings are written in `docs/` and used to set the default caps

## 4. Finalization

- [x] 4.1 Implement the finished-attempt consumer: check the schema still declares every bound property (`schema_changed` otherwise), assign the next version number in a transaction, conditional-put the immutable spec object, record the version, and update the attempt; verify integration tests including two simultaneous finalizations getting distinct numbers
- [x] 4.2 Implement version listing and retrieval scoped to the owning customer (newest first, other customers get "not found"); verify integration tests for both
- [x] 4.3 Verify storing a version never changes the active version (interim `active.json` untouched); integration test with version 2 active and version 3 stored

## 5. Infrastructure (AWS)

- [ ] 5.1 Define the discovery queue and DLQ (`maxReceiveCount: 3`, visibility timeout above the maximum attempt duration), the finished-attempt queue and the evidence prefix; verify the IaC plan or synth shows these settings
- [ ] 5.2 Build the worker image (Chromium, Puppeteer MCP, runner library) and define the Fargate service scaled by queue depth between 0 and 2 tasks, in subnets with no route to the database; verify a message starts a task and an empty queue scales back to zero
- [ ] 5.3 Define the task role limited to its S3 prefixes, the two queues and model access, with no database permissions; verify the worker cannot read outside its prefixes
- [ ] 5.4 Decide Bedrock versus the Anthropic API from region and model availability and configure model access and secrets accordingly; verify an attempt runs end to end with the chosen provider and record the decision in `docs/`

## 6. Integration

- [ ] 6.1 End-to-end: request a full discovery for a dev site and verify a candidate version is stored with evidence, the active version is untouched, and the preview endpoint can run the candidate
- [ ] 6.2 End-to-end: add a property to the dev catalog's schema, request an incremental discovery, and verify the new version contains the old bindings unchanged plus the new one
- [ ] 6.3 End-to-end: against a fixture site whose markup is changed to break two bound properties, request a repair and verify the new version replaces only those two bindings, the other values are identical, and the evidence shows before and after
- [ ] 6.4 Hostile-site checks: a fixture site with an injection text and redirects to internal addresses produces no leakage and a recorded guard event; verify the attempt either yields a verified candidate or a clear failure reason
