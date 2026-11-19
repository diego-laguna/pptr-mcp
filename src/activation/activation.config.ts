export interface ActivationConfig {
  scheduleGroupName: string;
  triggerQueueArn: string;
  schedulerRoleArn: string;
  /** Shortest interval a customer may schedule a site at. */
  minIntervalMinutes: number;
  /** How often schedules are reconciled with the stored cadences; 0 disables the timer. */
  reconcileIntervalMinutes: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(
      `${name} is not set; the activation module needs it to start`,
    );
  return value;
}

function nonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadActivationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ActivationConfig {
  return {
    scheduleGroupName: env.SCHEDULE_GROUP_NAME?.trim() || 'scrapes',
    triggerQueueArn: required(env, 'TRIGGER_QUEUE_ARN'),
    schedulerRoleArn: required(env, 'SCHEDULER_ROLE_ARN'),
    minIntervalMinutes: Math.max(
      1,
      nonNegativeInt(env, 'SCHEDULE_MIN_INTERVAL_MINUTES', 60),
    ),
    reconcileIntervalMinutes: nonNegativeInt(
      env,
      'SCHEDULE_RECONCILE_MINUTES',
      15,
    ),
  };
}
