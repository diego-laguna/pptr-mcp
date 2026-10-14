# Spec Delta

## Purpose

Defines how a catalog scrape for a site is requested, from the recurring schedule, an on-demand call or a preview, so that every request follows one path, is recorded, and is acknowledged without waiting for the scrape itself.

## ADDED Requirements

### Requirement: Refresh requests are enqueued, not executed inline
The internal refresh endpoint `POST /internal/sites/{siteId}/refresh` SHALL enqueue a production scrape of the site's active spec version and respond `202 Accepted` with a `runId`, without running the scrape within the request.

#### Scenario: On-demand refresh accepted
- **WHEN** an authorized caller posts to the refresh endpoint for a site with an active spec
- **THEN** the system records a run, enqueues one scrape request and responds `202` with the `runId`

#### Scenario: Unknown site
- **WHEN** the caller posts to the refresh endpoint for a `siteId` that does not exist
- **THEN** the system responds `404` and enqueues nothing

#### Scenario: Site without an active spec
- **WHEN** the site has no active spec version
- **THEN** the system responds `409` with code `no_active_spec` and enqueues nothing

### Requirement: Preview requests
The internal endpoint `POST /internal/sites/{siteId}/preview` SHALL enqueue a preview run of a named candidate spec version, limited to a small number of pages and items, and respond `202 Accepted` with a `runId`.

#### Scenario: Preview accepted
- **WHEN** an authorized caller requests a preview of an existing candidate spec version of the site
- **THEN** a preview run is recorded and enqueued with the page and item limits, and the response is `202` with the `runId`

#### Scenario: Unknown spec version
- **WHEN** the requested candidate spec version does not exist for the site
- **THEN** the system responds `404` and enqueues nothing

#### Scenario: Preview leaves the active spec alone
- **WHEN** a preview of a candidate version is requested
- **THEN** the site's active spec version is unchanged

### Requirement: Scheduled and on-demand refreshes share one path
The recurring schedule SHALL create the same kind of production request as the refresh endpoint, one schedule per site, and a site's schedule SHALL be creatable, changeable and removable at runtime.

#### Scenario: Scheduled tick
- **WHEN** a site's schedule fires
- **THEN** a production scrape request for that site is enqueued exactly as if the refresh endpoint had been called

#### Scenario: Schedule removed
- **WHEN** a site's schedule is removed
- **THEN** no further scheduled requests are created for that site

### Requirement: At most one pending scrape per site and mode
The system SHALL NOT hold more than one queued or running production request per site, nor more than one queued or running preview request per site and spec version; a request for a combination that already has one SHALL be treated as a duplicate and answered with the existing run, and a preview SHALL never be answered with the run of a different spec version.

#### Scenario: Duplicate production request
- **WHEN** a refresh is requested for a site that already has a queued or running production scrape
- **THEN** no second scrape is started and the caller receives `202` with the `runId` of the existing run

#### Scenario: Duplicate preview of the same version
- **WHEN** a preview of version 3 is requested while a preview of version 3 of the same site is queued or running
- **THEN** no second preview is started and the caller receives `202` with the `runId` of the existing run

#### Scenario: Preview of a different version
- **WHEN** a preview of version 4 is requested while a preview of version 3 of the same site is queued or running
- **THEN** a new preview run for version 4 is recorded and enqueued, and the response carries its own `runId`

#### Scenario: Preview during a production run
- **WHEN** a preview is requested while a production scrape of the same site is running
- **THEN** the preview is accepted and both proceed

### Requirement: Internal endpoints are not publicly reachable
The internal refresh and preview endpoints SHALL reject callers that lack the internal service credential or network access.

#### Scenario: Unauthenticated caller
- **WHEN** a request without valid internal credentials reaches either endpoint
- **THEN** the system rejects it with `401` or `403` and enqueues nothing
