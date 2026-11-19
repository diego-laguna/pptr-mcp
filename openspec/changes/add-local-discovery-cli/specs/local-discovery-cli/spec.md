## ADDED Requirements

### Requirement: Run one discovery attempt locally
The system SHALL provide a command that runs a single discovery attempt from a site URL and a schema file on the developer's machine, using the same worker, browsing guard, verifier and agent runner as production, without a database, queue or cloud services.

#### Scenario: Successful run
- **WHEN** the command is run with a reachable site URL, a valid schema file and model credentials
- **THEN** the attempt runs to completion, the output directory contains the candidate spec, the evidence and the annotated screenshots, and the command prints the outcome, turns, duration and cost

#### Scenario: Failed attempt
- **WHEN** the attempt ends without a candidate
- **THEN** the command prints the failure reason and detail, writes the evidence that exists, and exits with a non-zero status

#### Scenario: No cloud access needed
- **WHEN** the command runs without AWS credentials and with an API key set
- **THEN** it does not attempt any AWS call

### Requirement: Validate inputs before spending
The command SHALL validate its inputs and the model credentials before launching the browser or calling the model, and SHALL fail with a message naming the problem.

#### Scenario: Invalid schema file
- **WHEN** the schema file is missing, is not valid JSON, or does not pass the catalog schema validation (for example an unknown type, a reserved name, or two variant properties)
- **THEN** the command exits non-zero naming each problem with its path and makes no model call

#### Scenario: Missing credentials
- **WHEN** neither an API key nor Bedrock settings are present
- **THEN** the command exits non-zero saying which variables to set

#### Scenario: Unknown target property
- **WHEN** a requested property is not in the schema file
- **THEN** the command exits non-zero naming the property

### Requirement: Schema file is a catalog schema
The command SHALL accept the schema file as a full catalog schema, the same document a catalog stores, and SHALL give the attempt the same schema snapshot that production would derive from it.

#### Scenario: Catalog schema accepted as is
- **WHEN** the schema file is a valid catalog schema with `filterable` fields and one `variant` property
- **THEN** the attempt's snapshot lists the properties without `filterable` and names the variant property as `variantProperty`

#### Scenario: No variant property
- **WHEN** no property is flagged `variant`
- **THEN** the snapshot's `variantProperty` is null

### Requirement: Modes and base spec
The command SHALL support the `full`, `incremental` and `repair` modes, and the latter two SHALL require a base spec file that passes spec validation.

#### Scenario: Incremental without base
- **WHEN** the mode is `incremental` or `repair` and no base spec file is given
- **THEN** the command exits non-zero before any model call

#### Scenario: Repair with base
- **WHEN** the mode is `repair` with a valid base spec and the target properties
- **THEN** the attempt runs the repair checks against the base exactly as production does

### Requirement: Caps
The command SHALL apply turn, duration and cost caps, defaulting to a low local profile, and SHALL allow each to be overridden by a flag.

#### Scenario: Default local caps
- **WHEN** no cap flags are given
- **THEN** the attempt uses the local default caps, which are printed at start

#### Scenario: Cap reached
- **WHEN** the cost cap is reached
- **THEN** the attempt ends with `cap_exceeded` and the output reports the usage so far

### Requirement: Safety checks remain on
The command SHALL keep the production URL safety check and browsing guard enabled. Loopback and private addresses SHALL be allowed only when the user passes an explicit flag, and the run SHALL state that the flag is on.

#### Scenario: Private address refused by default
- **WHEN** the site URL resolves to a loopback or private address and the flag is not given
- **THEN** the command refuses the run with `unreachable_site` semantics and makes no model call

#### Scenario: Local fixture allowed by flag
- **WHEN** the flag is given and the site is served on loopback
- **THEN** the attempt runs, and the output states that private addresses were allowed

#### Scenario: Guard still confines navigation
- **WHEN** the flag is given and the page navigates to another domain
- **THEN** the top-level navigation is still blocked and recorded in the evidence

### Requirement: Output isolation
Each run SHALL write to its own directory under a configurable output root and SHALL NOT overwrite a previous run.

#### Scenario: Two runs
- **WHEN** the command is run twice
- **THEN** the second run writes to a new directory and the first is untouched
