# catalog-schemas Specification

## Purpose

Defines the customer-authored schema of a catalog: the typed, described properties a product carries beyond the system fields, the single optional variant property, and how the schema evolves while keeping stored data and sites consistent.

## Requirements

### Requirement: Property definition
Each schema property SHALL have a name, a type (string, number, boolean, url, date, enum or string list), a non-empty description, and flags for required and filterable; an enum property SHALL list its allowed values, and an optional example, when given, SHALL conform to the property's type. A date value SHALL be an ISO 8601 calendar date (`YYYY-MM-DD`).

#### Scenario: Valid property
- **WHEN** a property `price_note` of type string has a description
- **THEN** it is accepted

#### Scenario: Missing description
- **WHEN** a property is defined with an empty description
- **THEN** the schema is rejected

#### Scenario: Enum without values
- **WHEN** an enum property lists no allowed values
- **THEN** the schema is rejected

#### Scenario: Example of the wrong type
- **WHEN** a number property has the example `"abc"`
- **THEN** the schema is rejected

#### Scenario: Date example in a site's format
- **WHEN** a date property has the example `"15/10/2026"`
- **THEN** the schema is rejected, because examples use the canonical `YYYY-MM-DD` form

#### Scenario: Valid date property
- **WHEN** a property `promotion_date` of type date has the example `"2026-10-15"`
- **THEN** it is accepted

### Requirement: Property names
A property name SHALL be lowercase letters, digits and underscores starting with a letter, SHALL be unique within the schema, and SHALL NOT equal a system field name (`name`, `link`, `price`, `thumbnail_url`, `updated`, `available`).

#### Scenario: Reserved name
- **WHEN** a schema defines a property called `price`
- **THEN** the schema is rejected

#### Scenario: Duplicate name
- **WHEN** a schema defines `size` twice
- **THEN** the schema is rejected

#### Scenario: Invalid characters
- **WHEN** a property is named `Talle Niño`
- **THEN** the schema is rejected

### Requirement: Schema size limit
A schema SHALL contain at most 50 properties.

#### Scenario: Too many properties
- **WHEN** a schema defines 51 properties
- **THEN** it is rejected

### Requirement: Optional variant property
A schema MAY designate at most one property as its variant property, the one that splits a product into separately priced variants; the designation SHALL be fixed when the catalog is created.

#### Scenario: Two variant properties
- **WHEN** a schema designates both `size` and `color` as variant properties
- **THEN** the schema is rejected

#### Scenario: Designating a variant property later
- **WHEN** a change tries to designate a variant property on an existing catalog that has none
- **THEN** it is rejected and the schema is unchanged

### Requirement: Schema versions
Every structural change to a schema SHALL produce a new, immutable schema version recorded with the operations that produced it; the catalog SHALL always have exactly one current version.

#### Scenario: History retained
- **WHEN** a catalog's schema changes twice
- **THEN** versions 1, 2 and 3 exist, each with its properties, and version 3 is current

#### Scenario: Description-only edit
- **WHEN** only the description, example or filterable flag of a property is edited
- **THEN** the property is updated in place and the schema version does not change

### Requirement: Adding a property
Adding a property SHALL create a new schema version, leave stored products untouched, and mark every site of the catalog as needing attention with reason `property_pending` naming the property.

#### Scenario: Property added
- **WHEN** an optional property `fabric` is added to a catalog with three sites
- **THEN** the current version increases by one, no product is changed, and each of the three sites has a `property_pending` entry for `fabric`

#### Scenario: Required property added to a catalog with products
- **WHEN** a required property is added to a catalog that already has products
- **THEN** the change is rejected, because existing products cannot have the value

### Requirement: Renaming a property
Renaming a property SHALL create a new schema version and rename the corresponding key in every stored product's attributes, without requiring discovery and without marking sites as needing attention.

#### Scenario: Rename with stored data
- **WHEN** `gender` is renamed to `audience` in a catalog with stored products
- **THEN** every product's attributes use `audience` with its previous value, and `gender` appears nowhere

#### Scenario: Name collision
- **WHEN** a property is renamed to the name of another property
- **THEN** the change is rejected and nothing changes

#### Scenario: Renaming the variant property
- **WHEN** the variant property `size` is renamed to `talle`
- **THEN** the schema's variant property is `talle` and stored variants keep their values

### Requirement: Removing a property
Removing a property SHALL create a new schema version and delete the property's key from every stored product's attributes, without requiring discovery and without marking sites as needing attention; the variant property SHALL NOT be removable.

#### Scenario: Removal with stored data
- **WHEN** `unit_system` is removed from a catalog with stored products
- **THEN** no product's attributes contain `unit_system` afterwards

#### Scenario: Removing the variant property
- **WHEN** a change removes the variant property
- **THEN** it is rejected and the schema and data are unchanged

### Requirement: Changing a property's type
Changing the type of an existing property SHALL be rejected; the same effect SHALL be achieved by removing the property and adding a new one.

#### Scenario: Retype attempt
- **WHEN** a change sets `size` from string to number
- **THEN** it is rejected with a message to remove and re-add the property

### Requirement: Enum value changes
Adding an allowed value to an enum property SHALL be accepted without marking sites; removing a value SHALL be rejected while any stored product uses it.

#### Scenario: Value added
- **WHEN** a value is added to an enum property
- **THEN** the change is accepted and stored products are untouched

#### Scenario: Value in use
- **WHEN** a value that stored products use is removed
- **THEN** the change is rejected and the schema is unchanged

### Requirement: Schema changes are explicit and atomic
A schema change SHALL be expressed as explicit operations (add, rename, remove, edit description, add or remove enum value), SHALL be applied to one catalog at a time, and SHALL either fully apply the new version, the data migration and any site markers, or change nothing.

#### Scenario: Failure part-way
- **WHEN** a rename's data migration fails
- **THEN** the schema version, the stored attributes and the site markers are all unchanged

#### Scenario: Two concurrent changes
- **WHEN** two changes to the same catalog are submitted at the same time
- **THEN** they are applied one after the other, each producing its own version
