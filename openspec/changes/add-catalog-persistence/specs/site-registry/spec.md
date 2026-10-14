# Spec Delta

## Purpose

Defines the sites a customer attaches to a catalog, each scraped under the catalog's schema, and the attention markers that tell a customer a site needs a follow-up action.

## ADDED Requirements

### Requirement: Site record
Each site SHALL belong to exactly one catalog and have a URL that is unique within that catalog, a name, a country (ISO 3166-1 alpha-2) and a currency (ISO 4217).

#### Scenario: Valid site
- **WHEN** a site is added to a catalog with URL, name, country `AR` and currency `ARS`
- **THEN** it is accepted

#### Scenario: Duplicate URL in the same catalog
- **WHEN** a second site with the same URL is added to the same catalog
- **THEN** it is rejected

#### Scenario: Same URL in another catalog
- **WHEN** the same URL is added to a different catalog
- **THEN** it is accepted

#### Scenario: Unknown catalog
- **WHEN** a site is added to a catalog that does not exist or belongs to another customer
- **THEN** it is rejected as "not found"

### Requirement: Sites follow their catalog's schema
All sites of a catalog SHALL use that catalog's schema; a site SHALL NOT have a schema of its own.

#### Scenario: Two sites, one schema
- **WHEN** two sites belong to one catalog
- **THEN** both are subject to the same current schema version

### Requirement: Site attention markers
A site SHALL be able to carry attention markers, each with a reason code, an optional property name and a creation time; a marker SHALL stay until it is explicitly cleared.

#### Scenario: Marker created by a schema change
- **WHEN** a property is added to a catalog's schema
- **THEN** each of its sites has a `property_pending` marker naming that property

#### Scenario: Marker cleared
- **WHEN** a marker is cleared
- **THEN** it no longer appears among the site's active markers and its history is retained

#### Scenario: Markers do not block the site
- **WHEN** a site has an active marker
- **THEN** the site and its stored products remain readable and writable

### Requirement: Removing a site
Removing a site SHALL delete its products and variants and its markers.

#### Scenario: Site removed
- **WHEN** a site with products is removed
- **THEN** its products, variants and markers no longer exist and other sites are unaffected
