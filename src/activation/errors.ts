export type ActivationErrorCode =
  | 'preview_required'
  | 'discarded'
  | 'schema_changed'
  | 'stale_activation'
  | 'no_active_spec'
  | 'active_version';

/** Conflicts with the current state (HTTP 409). */
export class ActivationConflictError extends Error {
  constructor(
    readonly code: ActivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActivationConflictError';
  }
}

/** The request is well formed but not acceptable (HTTP 422). */
export class ActivationValidationError extends Error {
  constructor(
    readonly code:
      | 'cadence_required'
      | 'unacknowledged_properties'
      | 'invalid_acknowledgment'
      | 'invalid_cadence',
    message: string,
    readonly properties: string[] = [],
  ) {
    super(message);
    this.name = 'ActivationValidationError';
  }
}
