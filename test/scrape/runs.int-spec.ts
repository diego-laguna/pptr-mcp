import { NotFoundError } from '../../src/catalog/errors.js';
import { RunsRepository } from '../../src/scrape/api/runs.repository.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { createSite } from './support.js';

let db: TestDatabase;
let runs: RunsRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  runs = new RunsRepository(db.pool);
});
afterAll(async () => {
  await db.close();
});

const production = (siteId: string) => ({
  siteId,
  mode: 'production' as const,
  specVersion: 1,
  schemaVersion: 1,
});
const preview = (siteId: string, specVersion: number) => ({
  siteId,
  mode: 'preview' as const,
  specVersion,
  schemaVersion: 1,
});

describe('scrape_runs pending uniqueness', () => {
  it('refuses a second pending production run for a site and returns the existing one', async () => {
    const { customer, site } = await createSite(db, 'Prod');
    const first = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    const second = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false });
    expect(second.run.id).toBe(first.run.id);

    await expect(
      db.pool.query(
        `INSERT INTO scrape_runs (site_id, mode, spec_version, schema_version) VALUES ($1, 'production', 1, 1)`,
        [site.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a second preview of the same version', async () => {
    const { customer, site } = await createSite(db, 'Same');
    const first = await runs.createOrGetPending(
      customer.id,
      preview(site.id, 3),
    );
    const second = await runs.createOrGetPending(
      customer.id,
      preview(site.id, 3),
    );
    expect(second).toMatchObject({ created: false });
    expect(second.run.id).toBe(first.run.id);
  });

  it('allows a preview of another version and a production run beside a preview', async () => {
    const { customer, site } = await createSite(db, 'Mixed');
    const p3 = await runs.createOrGetPending(customer.id, preview(site.id, 3));
    const p4 = await runs.createOrGetPending(customer.id, preview(site.id, 4));
    const prod = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    expect([p3, p4, prod].map((r) => r.created)).toEqual([true, true, true]);
    expect(new Set([p3.run.id, p4.run.id, prod.run.id]).size).toBe(3);
    // a preview of 4 is never answered with the run of 3
    expect(
      (await runs.createOrGetPending(customer.id, preview(site.id, 4))).run.id,
    ).toBe(p4.run.id);
  });

  it('accepts a new run once the pending one has finished', async () => {
    const { customer, site } = await createSite(db, 'Done');
    const first = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    await runs.markRunning(first.run.id);
    await runs.markSucceeded(first.run.id, {
      itemCount: 1,
      pageCount: 1,
      resultKey: 'k',
    });
    const second = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    expect(second.created).toBe(true);
  });

  it("treats another customer's site as not found", async () => {
    const { site } = await createSite(db, 'Mine');
    const other = await createSite(db, 'Other');
    await expect(
      runs.createOrGetPending(other.customer.id, production(site.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('moves a run through queued, running and succeeded', async () => {
    const { customer, site } = await createSite(db, 'Life');
    const { run } = await runs.createOrGetPending(
      customer.id,
      production(site.id),
    );
    expect(run.status).toBe('queued');
    await runs.markRunning(run.id);
    expect((await runs.get(customer.id, run.id)).status).toBe('running');
    await runs.markSucceeded(run.id, {
      itemCount: 7,
      pageCount: 2,
      resultKey: 'k',
    });
    const done = await runs.get(customer.id, run.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      itemCount: 7,
      pageCount: 2,
    });
    expect(done.finishedAt).toBeInstanceOf(Date);
  });
});
