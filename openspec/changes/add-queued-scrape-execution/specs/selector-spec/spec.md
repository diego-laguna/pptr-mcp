# Spec Delta

## Purpose

Defines the selector spec: the declarative, versioned JSON document that describes how to reach and extract one site's catalog (navigation, pagination, item selectors, raw-to-typed transforms), so that discovery can produce it and a fixed runner can execute it without running any code from the document.

## ADDED Requirements

### Requirement: Declarative, versioned document
A selector spec SHALL be a JSON document that declares its format version and the site it applies to, and SHALL contain only data: no executable code or expressions.

#### Scenario: Valid spec
- **WHEN** a spec with a supported format version, a site URL and valid bindings is loaded
- **THEN** it is accepted

#### Scenario: Unsupported format version
- **WHEN** a spec declares a format version the runner does not support
- **THEN** it is rejected as `invalid_spec`

#### Scenario: Embedded code
- **WHEN** a spec contains a field that holds a script or function body
- **THEN** it is rejected as `invalid_spec` and nothing is executed

### Requirement: Closed vocabulary of navigation steps
A spec SHALL describe reaching the catalog using only the supported step types (open URL, click, wait for an element, scroll) and pagination modes (next button, URL template, infinite scroll), each with a bounded maximum number of pages.

#### Scenario: Unknown step type
- **WHEN** a spec uses a step type outside the vocabulary
- **THEN** it is rejected as `invalid_spec`

#### Scenario: Pagination without a bound
- **WHEN** a spec declares pagination with no maximum page count
- **THEN** it is rejected as `invalid_spec`

### Requirement: Item and property bindings
A spec SHALL identify the product item elements and bind each system field (`name`, `link`, `price`, `thumbnail_url`) and each extracted schema property to a locator (CSS selector or XPath) and a source (element text or a named attribute).

#### Scenario: Missing system field binding
- **WHEN** a spec has no binding for `link`
- **THEN** it is rejected as `invalid_spec`

#### Scenario: Malformed locator
- **WHEN** a binding's XPath is syntactically invalid
- **THEN** the spec is rejected as `invalid_spec`

### Requirement: Variant bindings
When the catalog's schema has a variant property, a spec SHALL bind how the variant options of an item are found, with a value, price and availability for each.

#### Scenario: Variants bound
- **WHEN** a spec for a catalog with a variant property binds variant value, price and availability
- **THEN** each extracted item can carry several variants

### Requirement: Closed vocabulary of transforms
A binding MAY declare an ordered chain of transforms from the supported set (trim, regex capture, locale number parse, date parse with a format and locale, text-to-enum map, text-to-boolean map, split into a list), and each transform SHALL be deterministic.

#### Scenario: Date transform
- **WHEN** a binding for a date property declares a date parse with format `dd/MM/yyyy`
- **THEN** raw text `15/10/2026` becomes the value `2026-10-15`

#### Scenario: Locale number
- **WHEN** a number binding declares locale `es-AR` and the raw text is `12.990,50`
- **THEN** the value is the number 12990.5

#### Scenario: Unknown transform
- **WHEN** a binding names a transform outside the vocabulary
- **THEN** the spec is rejected as `invalid_spec`

### Requirement: Immutable versions
Each spec version SHALL be immutable once stored; a change SHALL create a new version, and runs SHALL reference a specific version.

#### Scenario: Attempt to overwrite
- **WHEN** a store of an existing spec version with different content is attempted
- **THEN** it is rejected and the stored version is unchanged
