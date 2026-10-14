# Spec Delta

## Purpose

Defines how a queued scrape runs a site's selector spec without AI, records raw and typed values, decides whether a run is complete, and hands complete production results to reconciliation, so that incomplete or stale runs never remove or corrupt catalog data.

## ADDED Requirements

### Requirement: Scrape runs the site's selector spec without AI
A queued scrape SHALL execute the referenced selector spec version through the fixed runner using browser automation only, SHALL NOT make LLM or MCP calls, and SHALL NOT execute code from the spec.

#### Scenario: Successful run
- **WHEN** a scrape request for a site with a valid spec is processed
- **THEN** the runner follows the spec's steps and produces items with their values

#### Scenario: Spec missing
- **WHEN** the referenced spec version cannot be found
- **THEN** the run fails with reason `no_spec`

#### Scenario: Spec invalid
- **WHEN** the referenced spec fails validation
- **THEN** the run fails with reason `invalid_spec` and the browser is never opened

### Requirement: Spec must match the catalog schema
A run SHALL pin the catalog's schema version at the time it is requested and SHALL fail with reason `schema_mismatch` if the spec binds a property that the pinned schema does not declare.

#### Scenario: Property renamed after the spec was written
- **WHEN** the spec binds `gender` but the pinned schema no longer has it
- **THEN** the run fails with reason `schema_mismatch` and nothing is reconciled

#### Scenario: Property added after the spec was written
- **WHEN** the pinned schema has a property the spec does not bind
- **THEN** the run proceeds and that property is simply absent from every item

### Requirement: Raw and typed values are both recorded
For each item, the run result SHALL record the raw text extracted for each property, the typed value produced by its transforms, and any issues; a value that fails its transforms SHALL be omitted from the typed value and recorded as an issue with the raw text.

#### Scenario: Value parsed
- **WHEN** a date property's raw text `15/10/2026` is parsed by its transform
- **THEN** the item records raw `15/10/2026` and value `2026-10-15`

#### Scenario: Value fails to parse
- **WHEN** raw text `proximamente` cannot be parsed as a date
- **THEN** the item has no value for that property and an issue holding `proximamente`

#### Scenario: Only typed values are reconciled
- **WHEN** a complete production run is handed to reconciliation
- **THEN** reconciliation receives the typed values and not the raw text

### Requirement: Results are stored outside the queue under the owner's prefix
A run's full result SHALL be stored in object storage under a prefix that identifies the owning customer, catalog and site, and downstream steps SHALL receive a reference to it; raw results SHALL expire after a configured retention period (30 days by default).

#### Scenario: Large result
- **WHEN** a run's result exceeds the queue's maximum message size
- **THEN** the result is stored externally and the finished-run message carries only a reference

#### Scenario: Retention
- **WHEN** a stored raw result passes the retention period
- **THEN** it is removed automatically

### Requirement: Only complete production runs are reconciled
A production run SHALL be reconciled only when it is complete: it finished within its time limit, its item count is within the allowed deviation of the previous complete run, and for each property the share of present raw values that parsed is at least the configured minimum.

#### Scenario: Complete run
- **WHEN** a run finishes normally and passes the count and parse checks
- **THEN** its typed result is handed to reconciliation

#### Scenario: Run ends by timeout
- **WHEN** a run reaches its time limit before finishing
- **THEN** nothing is reconciled, no stored product is deleted, and the run fails with reason `timeout`

#### Scenario: Suspicious item count
- **WHEN** the item count falls outside the allowed deviation from the previous complete run
- **THEN** nothing is reconciled and the run fails with reason `count_anomaly`

#### Scenario: Too many parse failures
- **WHEN** a date property parses for only 60% of the items that had raw text and the minimum is 80%
- **THEN** nothing is reconciled and the run fails with reason `parse_anomaly`

#### Scenario: First run for a site
- **WHEN** the site has no previous complete run
- **THEN** the count check is skipped and the other checks still apply

### Requirement: Stale results are not stored
If the catalog's schema version has changed since the run was requested, the run SHALL be reported as failed with reason `stale_schema` and nothing SHALL be reconciled.

#### Scenario: Schema changed mid-run
- **WHEN** a property is renamed while a production run is in progress
- **THEN** the finished run is not reconciled and fails with reason `stale_schema`

### Requirement: Preview runs never change the catalog
A preview run SHALL apply the same runner and transforms as a production run within its page and item limits, SHALL store its result for later viewing, and SHALL NOT reconcile it, change any product, or publish a `failed_scrape` event.

#### Scenario: Preview completes
- **WHEN** a preview run finishes
- **THEN** its result with raw and typed values is available by reference and the catalog is unchanged

#### Scenario: Preview fails
- **WHEN** a preview run fails
- **THEN** the run record shows the failure reason and no `failed_scrape` event is published

### Requirement: Runs are recorded
Each requested run SHALL have a record holding its mode, site, spec version, pinned schema version, status (queued, running, succeeded or failed), failure reason, counts and timestamps.

#### Scenario: Record lifecycle
- **WHEN** a run is requested, started and finished successfully
- **THEN** its record moves from queued to running to succeeded with the item count

### Requirement: Failures are reported, transient ones retried
A failed production run SHALL publish a `failed_scrape` event with its reason; transient failures (browser crash, network error) SHALL be retried by redelivery and routed to a dead-letter queue after 3 receive attempts, while deterministic failures (`no_spec`, `invalid_spec`, `schema_mismatch`, `timeout`, `count_anomaly`, `parse_anomaly`, `stale_schema`) SHALL NOT be retried.

#### Scenario: Transient failure then success
- **WHEN** a run fails on its first attempt because the browser crashes and succeeds on a retry
- **THEN** the retried result is reconciled and no dead-letter entry is created

#### Scenario: Repeated transient failure
- **WHEN** a request fails transiently on 3 receive attempts
- **THEN** it is moved to the dead-letter queue and not retried further

#### Scenario: Deterministic failure
- **WHEN** a run fails with `count_anomaly`
- **THEN** it is not retried and a `failed_scrape` event with that reason is published

### Requirement: Concurrent scrapes are bounded
The system SHALL limit how many scrapes run at the same time to a configured maximum.

#### Scenario: More requests than the limit
- **WHEN** more scrape requests are queued than the configured maximum concurrency
- **THEN** the excess requests wait in the queue and start as running scrapes finish
