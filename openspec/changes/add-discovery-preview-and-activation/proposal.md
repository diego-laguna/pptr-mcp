# Proposal

## Why

`add-site-discovery` stores verified candidate selector specs and deliberately never activates them; `add-queued-scrape-execution` can preview a named version and run the active one, but resolves "active" from an interim `active.json` object in S3. Nothing yet lets a customer look at what discovery found, approve it, try again or put it into production, and nothing closes the loop on the `property_pending` markers a schema change creates. The product promise is that the customer sees a sample, decides, and activates the spec themselves; this change delivers that decision step and the real active pointer.

## What Changes

- A candidate version gets a **review**: when discovery stores a version, a preview run is enqueued automatically, and the review brings together the preview sample (raw next to typed values), the discovery evidence (annotated screenshots, unresolved properties, stability warnings, old-versus-new for repairs) and the properties still unbound.
- **Activation** is an explicit action on a stored version: it requires a completed preview of that exact version (a version that was active before may be re-activated without a new one), moves the site's active pointer in PostgreSQL with a compare-and-set on the version being replaced, records who approved which preview, and clears `property_pending` markers only for properties the version binds.
- Required schema properties that the version leaves unbound must be **acknowledged explicitly** in the activation request; an activation that omits any is rejected. The acknowledgment is stored on the activation record and the markers for those properties stay open.
- Activating a site's first version requires the customer's chosen cadence for that site, creates the site's recurring schedule from it and triggers one production scrape; later activations leave the schedule alone. Running scrapes keep the version they were enqueued with.
- **Cadence is defined by the customer, per site.** The cadence is stored in the database as the source of truth, can be changed at any time while the site has an active version, and is bounded by an operator-configured minimum interval so prospects cannot schedule runs more often than the POC allows.
- **Rollback** is re-activating an older stored version. Every activation is recorded, so the history of which version was live and when is queryable.
- **Retry** has two paths: a new discovery for the site with fresh guidance text (site-scoped, the default), or an edit of a property description, which is a catalog-wide schema operation that already exists and is offered as an explicit second choice.
- A candidate can be **discarded**; discarded candidates cannot be activated and stay stored.
- The interim `active.json` pointer is replaced by the database pointer, behind the port the scrape change already defined.
- Endpoints stay internal (`/internal/...`); the "approved by" field is nullable until accounts exist.

## Capabilities

### New Capabilities
- `candidate-review`: how a stored candidate version is previewed automatically, what the review shows, and how a candidate is retried or discarded.
- `spec-activation`: the per-site active pointer, activation preconditions and acknowledgment, marker clearing, first-activation schedule and scrape, rollback, and the activation history.

### Modified Capabilities

None. `openspec/specs/` is empty; the pointer replacement is a change to the in-flight `add-queued-scrape-execution` assumption and is handled in design and tasks.

## Impact

- New code: review assembly, activation service (transaction with compare-and-set, marker clearing, activation record), schedule upsert and reconciler, preview-on-ready hook on the discovery finalizer, active-pointer implementation of the scrape change's resolution port.
- Depends on `add-catalog-persistence` (sites, `site_attention`, schemas), `add-queued-scrape-execution` (preview, production scrape, schedule manager, resolution port) and `add-site-discovery` (versions, attempts, evidence).
- New tables: `site_active_specs` (one current pointer per site), `site_activations` (history with preview run, acknowledged properties, approver) and `site_schedules` (the customer's cadence per site).
- Assumptions: there is no default cadence, so a first activation without one is rejected; cadence is a cron or rate expression with an optional IANA timezone (UTC when omitted); the minimum interval is configuration (one hour by default).
- Not in scope: customer authentication and ownership checks (accounts change), the customer-facing screens, pausing and resuming a site's schedule (changing the cadence is in scope), automatic activation, budgets, and reconciliation behavior for missing required values.
