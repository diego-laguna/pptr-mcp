# Spec Delta

## Purpose

Defines how a discovery attempt for a site is requested, checked for safety, pinned to the catalog schema, admitted, queued, bounded and recorded, so that every attempt is traceable, limited in cost and cannot be pointed at internal targets.

## ADDED Requirements

### Requirement: Discovery requests create attempts
The internal endpoint `POST /internal/sites/{siteId}/discoveries` SHALL create a discovery attempt for the site in `full`, `incremental` or `repair` mode with optional guidance text of at most 2000 characters, enqueue it, and respond `202 Accepted` with an `attemptId`.

#### Scenario: Full discovery accepted
- **WHEN** an authorized caller requests a full discovery for an existing site
- **THEN** an attempt is recorded as queued, enqueued, and the response is `202` with its `attemptId`

#### Scenario: Unknown site
- **WHEN** the site does not exist
- **THEN** the system responds `404` and creates nothing

#### Scenario: Guidance too long
- **WHEN** the guidance exceeds 2000 characters
- **THEN** the system responds `422` and creates nothing

### Requirement: Incremental discovery targets unbound properties only
An `incremental` request SHALL require an existing spec version to extend and SHALL name only schema properties that the base spec does not bind; if it names none, it SHALL default to all unbound properties of the current schema.

#### Scenario: Properties defaulted
- **WHEN** an incremental request names no properties and the base spec lacks `fabric` and `season`
- **THEN** the attempt targets exactly `fabric` and `season`

#### Scenario: Property already bound
- **WHEN** an incremental request names a property the base spec already binds
- **THEN** the system responds `422` and creates nothing

#### Scenario: No base spec
- **WHEN** an incremental request is made for a site with no spec version
- **THEN** the system responds `409` with code `no_base_spec` and creates nothing

### Requirement: Repair discovery targets bound properties only
A `repair` request SHALL require an active spec version for the site as its base and SHALL name only schema properties that the base spec binds; if it names none, it SHALL default to the properties that the site's most recent scrape reported as failing, and SHALL be rejected when there are none. Repair SHALL NOT target system fields; a site whose system fields no longer work is handled by `full` mode.

#### Scenario: Properties defaulted from the last scrape
- **WHEN** a repair request names no properties and the most recent scrape of the site reported `price` and `color` as failing
- **THEN** the attempt targets exactly `price` and `color`

#### Scenario: No failing properties known
- **WHEN** a repair request names no properties and the most recent scrape reported none failing
- **THEN** the system responds `422` and creates nothing

#### Scenario: Property not bound
- **WHEN** a repair request names a property the base spec does not bind
- **THEN** the system responds `422` and creates nothing

#### Scenario: No active spec
- **WHEN** a repair request is made for a site with no active spec version
- **THEN** the system responds `409` with code `no_base_spec` and creates nothing

### Requirement: Target URL safety
The site URL SHALL be an `http` or `https` URL without embedded credentials whose host resolves only to public addresses; a URL that targets loopback, private, link-local (including cloud metadata addresses) or otherwise reserved ranges SHALL be rejected before any attempt is queued.

#### Scenario: Private address
- **WHEN** a site's URL resolves to `10.0.0.5`
- **THEN** the request is rejected with `422` and nothing is queued

#### Scenario: Metadata address
- **WHEN** a site's URL host is or resolves to `169.254.169.254`
- **THEN** the request is rejected with `422`

#### Scenario: Unsupported scheme
- **WHEN** a site's URL uses `file:` or `ftp:`
- **THEN** the request is rejected with `422`

#### Scenario: Public site
- **WHEN** a site's URL resolves only to public addresses
- **THEN** the safety check passes

### Requirement: Attempts pin a schema snapshot
An attempt SHALL record the catalog's schema version and a snapshot of each property's name, type, description, example, enum values, required flag and the variant property at the time of the request, and SHALL use only that snapshot.

#### Scenario: Description edited after request
- **WHEN** a property description is edited while an attempt is running
- **THEN** the running attempt keeps the description it started with

#### Scenario: Schema changed structurally during an attempt
- **WHEN** a property that the candidate binds is renamed or removed before the attempt finishes
- **THEN** the attempt fails with reason `schema_changed` and no spec version is stored

### Requirement: One pending attempt per site
The system SHALL NOT hold more than one queued or running attempt per site; a request while one exists SHALL be answered with the existing attempt.

#### Scenario: Duplicate request
- **WHEN** a discovery is requested for a site with a queued or running attempt
- **THEN** no new attempt is created and the response is `202` with the existing `attemptId`

### Requirement: Attempt record and outcomes
Each attempt SHALL have a record with its mode, targeted properties, pinned schema version, status (queued, running, candidate_ready or failed), failure reason, resulting spec version, usage (turns, duration, and tokens or cost where available) and timestamps; failure reasons SHALL be one of `unreachable_site`, `blocked_by_site`, `no_catalog_found`, `verification_failed`, `invalid_output`, `cap_exceeded`, `budget_exhausted`, `schema_changed` or `error`.

#### Scenario: Successful attempt
- **WHEN** an attempt produces a verified candidate
- **THEN** its record is `candidate_ready` with the spec version number and its usage

#### Scenario: Failed attempt
- **WHEN** the site blocks the browser
- **THEN** the record is `failed` with reason `blocked_by_site`

### Requirement: Attempts are capped
Each attempt SHALL stop when it reaches the configured maximum number of agent turns, wall-clock duration or cost, whichever comes first, and fail with reason `cap_exceeded` keeping its recorded usage.

#### Scenario: Duration cap reached
- **WHEN** an attempt reaches its maximum duration before producing a verified candidate
- **THEN** it stops, no spec version is stored, and the record shows `cap_exceeded` with usage

### Requirement: Admission hook
Before an attempt is queued, the system SHALL consult an allowance check that MAY refuse it, in which case the request SHALL be rejected with reason `budget_exhausted` and nothing queued; with no budget configured, the check SHALL allow all attempts.

#### Scenario: Allowance refuses
- **WHEN** the allowance check refuses an attempt
- **THEN** the system responds `429` with reason `budget_exhausted` and creates no attempt

#### Scenario: No budget configured
- **WHEN** no allowance is configured
- **THEN** the attempt is admitted

### Requirement: Concurrency and retries
At most 2 attempts SHALL run at the same time; transient infrastructure failures SHALL be retried by redelivery up to 3 receive attempts and then routed to a dead-letter queue, while deterministic failures SHALL NOT be retried.

#### Scenario: Third request waits
- **WHEN** three attempts for different sites are queued
- **THEN** two run and the third starts when one finishes

#### Scenario: Deterministic failure
- **WHEN** an attempt fails with `no_catalog_found`
- **THEN** it is not retried
