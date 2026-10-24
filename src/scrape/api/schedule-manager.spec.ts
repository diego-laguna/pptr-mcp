import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { InternalScrapeController } from './internal-scrape.controller.js';
import { ScheduleManager } from './schedule-manager.js';
import { parseScrapeRequest } from './scrape-request.service.js';

const config = {
  groupName: 'scrapes',
  triggerQueueArn: 'arn:aws:sqs:us-east-1:1:trigger',
  roleArn: 'arn:aws:iam::1:role/s',
};
const siteId = 'a1d4a8e2-6a1c-4f43-b9a0-52b6e4f7c001';

function fakeClient(behaviour: (command: unknown) => unknown = () => ({})) {
  const commands: unknown[] = [];
  return {
    commands,
    send: async (command: unknown) => {
      commands.push(command);
      const out = behaviour(command);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

describe('ScheduleManager', () => {
  it('creates a schedule whose payload equals the refresh endpoint request', async () => {
    const client = fakeClient();
    await new ScheduleManager(client as never, config).upsert(
      siteId,
      'rate(1 hour)',
    );
    const command = client.commands[0] as CreateScheduleCommand;
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input).toMatchObject({
      Name: `scrape-${siteId}`,
      GroupName: 'scrapes',
      ScheduleExpression: 'rate(1 hour)',
      Target: { Arn: config.triggerQueueArn },
    });

    const requested: unknown[] = [];
    const controller = new InternalScrapeController({
      request: async (r: unknown) => (
        requested.push(r),
        { runId: 'x', created: true }
      ),
    } as never);
    await controller.refresh(siteId);
    const scheduled = JSON.parse(command.input.Target!.Input!);
    expect(scheduled).toEqual(requested[0]);
    expect(parseScrapeRequest(scheduled)).toEqual(requested[0]);
  });

  it('updates an existing schedule', async () => {
    const client = fakeClient((c) =>
      c instanceof CreateScheduleCommand
        ? new ConflictException({ message: 'exists', $metadata: {} })
        : {},
    );
    await new ScheduleManager(client as never, config).upsert(
      siteId,
      'rate(2 hours)',
    );
    expect(client.commands.map((c) => (c as object).constructor)).toEqual([
      CreateScheduleCommand,
      UpdateScheduleCommand,
    ]);
  });

  it('deletes the schedule so no further requests are created, and tolerates one that is gone', async () => {
    const client = fakeClient();
    const manager = new ScheduleManager(client as never, config);
    await manager.remove(siteId);
    expect((client.commands[0] as DeleteScheduleCommand).input).toEqual({
      Name: `scrape-${siteId}`,
      GroupName: 'scrapes',
    });
    const gone = fakeClient(
      () => new ResourceNotFoundException({ message: 'gone', $metadata: {} }),
    );
    await expect(
      new ScheduleManager(gone as never, config).remove(siteId),
    ).resolves.toBeUndefined();
  });
});
