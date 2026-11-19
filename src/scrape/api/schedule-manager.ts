import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  ConflictException,
  ListSchedulesCommand,
} from '@aws-sdk/client-scheduler';
import { productionRequest } from './scrape-request.service.js';

export interface ScheduleManagerConfig {
  groupName: string;
  /** ARN of the trigger queue that ticks are delivered to. */
  triggerQueueArn: string;
  /** Role the scheduler assumes to send to that queue. */
  roleArn: string;
}

const nameOf = (siteId: string) => `scrape-${siteId}`;

/**
 * One EventBridge Scheduler schedule per site. A tick delivers exactly the
 * request the refresh endpoint builds, to a queue the API consumes, so
 * scheduled and on-demand refreshes share one path.
 */
export class ScheduleManager {
  constructor(
    private readonly client: Pick<SchedulerClient, 'send'>,
    private readonly config: ScheduleManagerConfig,
  ) {}

  /** `expression` is an EventBridge Scheduler `rate(...)` or `cron(...)` expression; the timezone is IANA (UTC when omitted). */
  async upsert(
    siteId: string,
    cadence: string | { expression: string; timezone?: string },
  ): Promise<void> {
    const expression =
      typeof cadence === 'string' ? cadence : cadence.expression;
    const timezone = typeof cadence === 'string' ? undefined : cadence.timezone;
    const params = {
      Name: nameOf(siteId),
      GroupName: this.config.groupName,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: timezone ?? 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      State: 'ENABLED' as const,
      Target: {
        Arn: this.config.triggerQueueArn,
        RoleArn: this.config.roleArn,
        Input: JSON.stringify(productionRequest(siteId)),
      },
    };
    try {
      await this.client.send(new CreateScheduleCommand(params));
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      await this.client.send(new UpdateScheduleCommand(params));
    }
  }

  /** Removing a schedule that does not exist is not an error. */
  async remove(siteId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({
          Name: nameOf(siteId),
          GroupName: this.config.groupName,
        }),
      );
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }

  /** Ids of the sites that currently have a schedule in the group. */
  async listSiteIds(): Promise<string[]> {
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListSchedulesCommand({
          GroupName: this.config.groupName,
          NamePrefix: 'scrape-',
          NextToken: token,
        }),
      );
      for (const s of out.Schedules ?? []) {
        if (s.Name?.startsWith('scrape-'))
          ids.push(s.Name.slice('scrape-'.length));
      }
      token = out.NextToken;
    } while (token);
    return ids;
  }
}
