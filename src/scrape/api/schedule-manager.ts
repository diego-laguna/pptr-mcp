import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  ConflictException,
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

  /** `expression` is an EventBridge Scheduler `rate(...)` or `cron(...)` expression. */
  async upsert(siteId: string, expression: string): Promise<void> {
    const params = {
      Name: nameOf(siteId),
      GroupName: this.config.groupName,
      ScheduleExpression: expression,
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
}
