# Spec Delta

## Purpose

Defines customers and the private catalogs they own, so that every schema, site and product belongs to exactly one customer and is never visible to another.

## ADDED Requirements

### Requirement: Customer record
A customer SHALL have a unique identifier and a name.

#### Scenario: Customer created
- **WHEN** a customer is created with a name
- **THEN** it is stored with a generated identifier

### Requirement: Catalogs are owned by one customer
A catalog SHALL belong to exactly one customer and have a name that is unique among that customer's catalogs; a customer MAY own many catalogs, and different customers MAY use the same catalog name.

#### Scenario: Several catalogs for one customer
- **WHEN** a customer creates catalogs named "kids clothing" and "car parts"
- **THEN** both exist under that customer

#### Scenario: Duplicate name for the same customer
- **WHEN** a customer creates a second catalog with a name it already uses
- **THEN** the second is rejected

#### Scenario: Same name for another customer
- **WHEN** two different customers each create a catalog named "kids clothing"
- **THEN** both are accepted

### Requirement: A catalog starts with a schema
Creating a catalog SHALL require an initial schema, which becomes schema version 1 of that catalog.

#### Scenario: Catalog created with a schema
- **WHEN** a catalog is created with a valid schema
- **THEN** the catalog exists and its current schema version is 1

#### Scenario: Catalog created with an invalid schema
- **WHEN** a catalog is created with an invalid schema
- **THEN** it is rejected and no catalog is stored

### Requirement: Catalogs are private to their customer
Every read or write of a catalog, its schema, its sites or its products SHALL be scoped to a customer, and data owned by another customer SHALL behave as if it does not exist.

#### Scenario: Reading another customer's catalog
- **WHEN** customer B requests a catalog owned by customer A
- **THEN** the result is "not found", the same as for a catalog that does not exist

#### Scenario: Listing catalogs
- **WHEN** a customer lists catalogs
- **THEN** only that customer's catalogs are returned

#### Scenario: Writing into another customer's site
- **WHEN** customer B attempts to store a product for a site owned by customer A
- **THEN** the write is rejected as "not found" and nothing is stored

### Requirement: Development customer seed
The system SHALL provide an optional seed, enabled only by explicit configuration, that creates a development customer owning a catalog of the five PRD target sites (Grisino, Cheeky, Naranjo, Mimo, Baby Cottons); it SHALL NOT run by default.

#### Scenario: Seed enabled
- **WHEN** the seed is applied with the development setting enabled on an empty database
- **THEN** one customer exists, owning one catalog with five sites whose URLs are those in the PRD

#### Scenario: Seed not enabled
- **WHEN** the application starts without the development setting
- **THEN** no customer, catalog or site is created

#### Scenario: Seed applied twice
- **WHEN** the enabled seed is applied again
- **THEN** nothing is duplicated and existing identifiers are unchanged
