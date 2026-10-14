# Spec Delta

## Purpose

Defines the per-site active spec pointer and the explicit, checked, recorded action that moves it, so that scheduled and on-demand scrapes only ever run a spec a customer approved, and so that activation closes the attention markers it resolves.

## ADDED Requirements

### Requirement: One active version per site
A site SHALL have at most one active spec version at any time, recorded in the database; scheduled and on-demand scrapes SHALL use the version that is active when the run is requested, and a site with no active version SHALL have scrapes fail with reason `no_spec`.

#### Scenario: New site
- **WHEN** a site has never been activated
- **THEN** it has no active version and a refresh request produces a run that fails with `no_spec`

#### Scenario: Run keeps its version
- **WHEN** a production run was requested while version 2 was active and version 3 is activated before it finishes
- **THEN** the run completes using version 2

### Requirement: Activation preconditions
Activating a version SHALL be rejected unless the version belongs to the site, has not been discarded, has a completed (succeeded) preview run of that exact version or was previously active for the site, and every property it binds still exists in the catalog's current schema.

#### Scenario: Preview completed
- **WHEN** a version with a succeeded preview is activated
- **THEN** it becomes the site's active version

#### Scenario: No preview yet
- **WHEN** a version without a succeeded preview and never previously active is activated
- **THEN** the request is rejected with `409` and code `preview_required`

#### Scenario: Previously active version
- **WHEN** a version that was active before is activated again
- **THEN** no new preview is required

#### Scenario: Discarded version
- **WHEN** a discarded version is activated
- **THEN** the request is rejected with `409`

#### Scenario: Bound property no longer in the schema
- **WHEN** the version binds a property that was renamed or removed since it was authored
- **THEN** the request is rejected with `409` and code `schema_changed`

#### Scenario: Version of another site
- **WHEN** a version that belongs to a different site is named
- **THEN** the request is answered as "not found"

### Requirement: Activation is a checked replacement
An activation request SHALL name the version currently active for the site (or none for a first activation), and SHALL be rejected with `409` and code `stale_activation` if the active version is not the one named, so that two concurrent decisions cannot silently overwrite each other.

#### Scenario: Concurrent activations
- **WHEN** two callers both activate a version while version 2 is active, naming version 2
- **THEN** exactly one succeeds and the other is rejected with `stale_activation`

#### Scenario: Repeating an activation
- **WHEN** a request activates the version that is already active
- **THEN** it succeeds without creating a new activation record or changing anything

### Requirement: Unbound required properties are acknowledged
When the current schema declares required properties that the version does not bind, the activation request SHALL list every one of them as acknowledged; a request that omits any SHALL be rejected with `422` and the list of unacknowledged properties, and a listed name that is not an unbound required property SHALL also be rejected. The acknowledged properties SHALL be stored on the activation record.

#### Scenario: Required property unbound and acknowledged
- **WHEN** the schema requires `price` and `fabric`, the version leaves `fabric` unbound, and the request acknowledges `fabric`
- **THEN** the version is activated and the record lists `fabric` as acknowledged

#### Scenario: Required property unbound, not acknowledged
- **WHEN** the same request does not acknowledge `fabric`
- **THEN** it is rejected with `422` naming `fabric` and the active version is unchanged

#### Scenario: Optional property unbound
- **WHEN** the version leaves an optional property unbound
- **THEN** no acknowledgment is needed

#### Scenario: Not an unbound required property
- **WHEN** the request acknowledges a property that the version binds
- **THEN** it is rejected with `422`

### Requirement: Activation resolves attention markers
Activating a version SHALL clear the site's `property_pending` markers for the properties the version binds and SHALL leave markers for properties it does not bind and markers with other reasons untouched, in the same transaction as the pointer change.

#### Scenario: Markers cleared for bound properties
- **WHEN** a site has `property_pending` markers for `fabric` and `season` and the activated version binds `fabric` only
- **THEN** the `fabric` marker is cleared and the `season` marker remains

#### Scenario: Activation fails midway
- **WHEN** the pointer change cannot be committed
- **THEN** no marker is cleared

### Requirement: Activation history
Each activation SHALL be recorded with its site, version, the version it replaced, the preview run relied on, the acknowledged properties, the approver (empty until accounts exist) and its time, and the history SHALL be listable newest first, private to the owning customer.

#### Scenario: Record contents
- **WHEN** version 3 replaces version 2 relying on preview run R
- **THEN** the record names version 3, version 2, run R, any acknowledged properties and the time

#### Scenario: Another customer lists history
- **WHEN** another customer requests a site's activation history
- **THEN** the result is "not found"

### Requirement: First activation requires a cadence, then starts the schedule and one scrape
Activating the first version of a site SHALL require the cadence the customer chose for that site and SHALL be rejected with `422` and code `cadence_required` without it; it SHALL then store the cadence, create the site's recurring schedule from it and request one production scrape. Activations that replace an existing active version SHALL NOT change the schedule or request a scrape. The schedule SHALL be made consistent with the stored cadence even if its creation fails after the pointer change.

#### Scenario: First activation
- **WHEN** a site's first version is activated with a daily cadence
- **THEN** the cadence is stored, the site has a recurring schedule matching it and one production run is queued for that version

#### Scenario: First activation without a cadence
- **WHEN** a site's first version is activated without a cadence
- **THEN** the request is rejected with `422` `cadence_required` and nothing changes

#### Scenario: Replacement activation
- **WHEN** version 3 replaces version 2
- **THEN** the cadence and schedule are unchanged and no extra scrape is requested

#### Scenario: Schedule creation fails
- **WHEN** the pointer changes but the schedule cannot be created at that moment
- **THEN** the activation stands and the schedule is created later by reconciliation from the stored cadence

### Requirement: Customer-defined cadence per site
A site's cadence SHALL be defined by the customer for that site alone, as a cron or rate expression with an optional timezone (UTC when omitted); a cadence whose expression is invalid or whose interval is shorter than the configured minimum (one hour by default) SHALL be rejected with `422`. The customer SHALL be able to change a site's cadence at any time while the site has an active version; the change SHALL take effect for the site's schedule without affecting other sites, without requesting a scrape, and without affecting a run in progress.

#### Scenario: Change the cadence
- **WHEN** a customer changes a site's cadence from daily to every 6 hours
- **THEN** the stored cadence and the site's schedule are updated, other sites' schedules are unchanged and no scrape is requested

#### Scenario: Too frequent
- **WHEN** a cadence of every 5 minutes is given and the minimum interval is one hour
- **THEN** the request is rejected with `422` and the cadence is unchanged

#### Scenario: Invalid expression
- **WHEN** the expression cannot be parsed
- **THEN** the request is rejected with `422`

#### Scenario: Site without an active version
- **WHEN** a cadence change is requested for a site with no active version
- **THEN** the request is rejected with `409` and code `no_active_spec`

#### Scenario: Another customer's site
- **WHEN** another customer changes a site's cadence
- **THEN** the result is "not found" and nothing changes

### Requirement: Rollback
A previously active version that has not been discarded SHALL be re-activatable through the same activation request, replacing the current one, without a new preview.

#### Scenario: Roll back to version 2
- **WHEN** version 3 is active and version 2, previously active, is activated naming version 3 as current
- **THEN** version 2 is active, version 3 remains stored, and the activation is recorded

### Requirement: Activation is private to the customer
Activation, history and the active pointer of a site SHALL be accessible only within the owning customer's scope; another customer's request SHALL behave as if the site does not exist.

#### Scenario: Another customer activates
- **WHEN** customer B activates a version of customer A's site
- **THEN** the result is "not found" and nothing changes
