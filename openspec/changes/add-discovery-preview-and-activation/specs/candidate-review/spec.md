# Spec Delta

## Purpose

Defines how a stored candidate spec version is previewed and presented for a decision, and how a candidate is retried or discarded, so that a customer sees real sample data and the discovery evidence before anything goes live.

## ADDED Requirements

### Requirement: Candidates are previewed automatically
When discovery stores a new spec version, the system SHALL enqueue a preview run of that exact version without waiting for a request; the preview SHALL NOT be answered with the run of a different version of the same site.

#### Scenario: Preview after discovery
- **WHEN** a discovery attempt stores version 3 for a site
- **THEN** a preview run of version 3 is recorded and enqueued

#### Scenario: Another version is already being previewed
- **WHEN** version 4 is stored while a preview of version 3 is queued or running for the same site
- **THEN** a preview of version 4 is still created and is never reported as the run of version 3

#### Scenario: Preview can be requested again
- **WHEN** a preview of a stored version failed or its stored result has expired
- **THEN** an authorized caller can request a new preview of that version

### Requirement: Review of a candidate
The system SHALL provide, for a stored version, a review containing the version and its record, the status of its preview run, the preview sample with raw and typed values side by side when the preview succeeded, the discovery evidence (annotated screenshots, per-property parse rates, stability warnings, unresolved properties, and old-versus-new bindings for a repair), the schema properties the version leaves unbound with their required flags, and the version currently active for the site.

#### Scenario: Review after a successful preview
- **WHEN** a version's preview has succeeded
- **THEN** the review shows the sample items, the evidence and the unbound properties, and marks the version as ready to activate

#### Scenario: Preview still running
- **WHEN** the preview has not finished
- **THEN** the review shows the preview as pending and the version is not ready to activate

#### Scenario: Preview failed
- **WHEN** the preview run failed
- **THEN** the review shows the failure reason and the version is not ready to activate

#### Scenario: Review of another customer's version
- **WHEN** a version of another customer's site is requested
- **THEN** the result is "not found"

### Requirement: Retry with new guidance
A customer SHALL be able to retry discovery for a site from a review by requesting a new discovery attempt with new guidance text; the retry SHALL NOT modify, discard or activate the reviewed candidate, and SHALL NOT change the catalog's schema.

#### Scenario: Retry keeps the earlier candidate
- **WHEN** a retry with new guidance is requested for a site whose version 3 is under review
- **THEN** a new attempt is queued and version 3 remains stored and reviewable

#### Scenario: Retry extends the reviewed candidate
- **WHEN** a retry is requested in `incremental` mode naming the reviewed candidate as its base
- **THEN** the new attempt extends that candidate with bindings for properties it left unbound

#### Scenario: Guidance does not edit the schema
- **WHEN** a retry is requested with guidance about a property
- **THEN** the property's description in the catalog schema is unchanged

### Requirement: Discarding a candidate
A customer SHALL be able to discard a stored version that is not currently active; a discarded version SHALL remain stored and visible in the version list marked as discarded and SHALL NOT be activatable.

#### Scenario: Discard a candidate
- **WHEN** an authorized caller discards a stored version that is not active
- **THEN** the version is marked discarded and activating it is refused

#### Scenario: Discard the active version
- **WHEN** a caller discards the site's active version
- **THEN** the request is rejected with `409` and the version stays active
