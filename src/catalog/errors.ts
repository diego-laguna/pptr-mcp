import { ValidationIssue } from './schema/property-types.js';

/** Also used for rows that belong to another customer, so existence never leaks. */
export class NotFoundError extends Error {
  constructor(readonly entity: string) {
    super(`${entity} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ValidationFailedError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ValidationFailedError';
  }
}

/** A write was produced under a schema version that is no longer current. */
export class StaleSchemaError extends Error {
  constructor(
    readonly pinnedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `write was produced under schema version ${pinnedVersion} but the catalog is at version ${currentVersion}`,
    );
    this.name = 'StaleSchemaError';
  }
}

/** A schema change that is well-formed but not allowed in the current state. */
export class SchemaChangeRejectedError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = 'SchemaChangeRejectedError';
  }
}
