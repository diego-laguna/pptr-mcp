# catalog-storage Specification

## Purpose

Defines how catalog products and their variants are stored, the constraints that keep them consistent with their catalog's schema and customer, and the lookups the stored data must support.

## Requirements

### Requirement: Product identity
A product SHALL belong to one site and be unique within that site by its link; it SHALL carry a name, link, thumbnail URL, an attributes object and an updated timestamp.

#### Scenario: Same link on the same site
- **WHEN** a second product with the same site and link is stored
- **THEN** it is rejected

#### Scenario: Same link on different sites
- **WHEN** products with the same link are stored under two different sites
- **THEN** both are accepted

### Requirement: Attributes follow the catalog schema
A product's attributes SHALL contain only properties declared by its catalog's current schema, excluding the variant property, with values matching the declared types and enum values; missing properties SHALL be allowed unless the property is required.

#### Scenario: Undeclared attribute
- **WHEN** a product is stored with an attribute the schema does not declare
- **THEN** it is rejected

#### Scenario: Wrong value type
- **WHEN** a string property receives a numeric value
- **THEN** the product is rejected

#### Scenario: Value outside the enum
- **WHEN** an enum property receives a value not in its allowed list
- **THEN** the product is rejected

#### Scenario: Valid date
- **WHEN** a date property receives `2026-10-15`
- **THEN** the product is accepted and the value reads back as `2026-10-15`

#### Scenario: Non-canonical or impossible date
- **WHEN** a date property receives `15/10/2026` or `2026-02-31`
- **THEN** the product is rejected, since conversion from site text happens before storage

#### Scenario: Optional property missing
- **WHEN** a product is stored without an optional property
- **THEN** it is accepted and the property is simply absent

#### Scenario: Required property missing
- **WHEN** a product is stored without a required property
- **THEN** it is rejected

### Requirement: Writes are pinned to a schema version
A write SHALL declare the schema version it was produced under and SHALL be rejected as stale if that is not the catalog's current version.

#### Scenario: Stale write
- **WHEN** a result produced under schema version 2 is written after the catalog moved to version 3
- **THEN** the write is rejected as stale and nothing is stored

#### Scenario: Current write
- **WHEN** a result produced under the current version is written
- **THEN** it is accepted

### Requirement: Price shape depends on the variant property
When the catalog's schema has a variant property, price and availability SHALL be stored on product variants and not on the product; when it has none, price and availability SHALL be stored on the product and no variants SHALL exist. A price SHALL be stored as the text shown on the site.

#### Scenario: Catalog with a variant property
- **WHEN** a product is stored with a price on the product itself
- **THEN** it is rejected

#### Scenario: Catalog without a variant property
- **WHEN** a product is stored with variants
- **THEN** it is rejected

#### Scenario: Price text preserved
- **WHEN** a variant is stored with price `$ 12.990,00`
- **THEN** reading it returns exactly `$ 12.990,00`

### Requirement: Product variants
A variant SHALL belong to one product, be unique within it by variant value, and carry a price, an availability flag and an updated timestamp.

#### Scenario: Duplicate variant value
- **WHEN** a second variant with value `10` is stored for the same product
- **THEN** it is rejected

#### Scenario: Deleting a product
- **WHEN** a product is deleted
- **THEN** all of its variants are deleted with it

### Requirement: Supported lookups
The stored data SHALL support, within one customer's scope, selecting products by catalog or site, by attribute containment (for example audience `girls` and type `t-shirt`), by free text on name, and joining a product's variants by variant value.

#### Scenario: Attribute containment
- **WHEN** products are queried for audience `girls` and type `t-shirt`
- **THEN** only products whose attributes include both values are returned

#### Scenario: Variant by value
- **WHEN** variants are queried for value `10`
- **THEN** only variants with that value are returned, with their product

#### Scenario: Scope respected
- **WHEN** the same attribute query runs for a different customer
- **THEN** none of the first customer's products are returned
