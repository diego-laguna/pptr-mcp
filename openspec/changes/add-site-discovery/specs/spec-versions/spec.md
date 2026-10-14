# Spec Delta

## Purpose

Defines how selector spec versions are stored, numbered and retrieved per site, privately to the owning customer, so that discovery results are immutable candidates that never silently replace what is running.

## ADDED Requirements

### Requirement: Versions are immutable and numbered per site
A verified candidate SHALL be stored as a new spec version with the next integer number for its site; a stored version SHALL never be modified.

#### Scenario: First version
- **WHEN** the first verified candidate for a site is stored
- **THEN** it is version 1

#### Scenario: Next version
- **WHEN** a second verified candidate is stored for the same site
- **THEN** it is version 2 and version 1 is unchanged

#### Scenario: Concurrent finalization
- **WHEN** two candidates for the same site are finalized at the same time
- **THEN** they receive distinct consecutive numbers and neither overwrites the other

### Requirement: Version records
Each version SHALL have a record with its site, number, source (discovery), discovery mode, originating attempt, the base version it extends or repairs (when any), the schema version it was authored against, the properties it binds and its creation time.

#### Scenario: Record contents
- **WHEN** a version is stored from attempt A against schema version 3
- **THEN** its record names attempt A, schema version 3 and the bound properties

### Requirement: Candidate must match the current schema
A candidate SHALL be stored only if every property it binds still exists in the catalog's current schema; properties added to the schema since the attempt started SHALL NOT block storing.

#### Scenario: Bound property removed
- **WHEN** the schema no longer declares a property the candidate binds
- **THEN** the candidate is not stored and the attempt fails with reason `schema_changed`

#### Scenario: Property added meanwhile
- **WHEN** a new property was added to the schema during the attempt
- **THEN** the candidate is stored and simply does not bind the new property

### Requirement: Storing a version does not activate it
Storing a version SHALL NOT change which version of the site is active, and scheduled or manual scrapes SHALL continue to use the active version.

#### Scenario: Active version unchanged
- **WHEN** version 3 is stored while version 2 is active
- **THEN** version 2 remains active

### Requirement: Versions are private to their customer
Spec versions, their records and their evidence SHALL be readable only within the owning customer's scope; another customer's request SHALL behave as if they do not exist.

#### Scenario: Another customer reads a version
- **WHEN** customer B requests a spec version of customer A's site
- **THEN** the result is "not found"

#### Scenario: Listing versions
- **WHEN** an owner lists a site's versions
- **THEN** all versions with their records are returned, newest first
