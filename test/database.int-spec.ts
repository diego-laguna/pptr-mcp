import { createTestDatabase, TestDatabase } from './support/test-database.js';

describe('test database helper', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('connects and runs select 1', async () => {
    const result = await db.pool.query('select 1 as one');
    expect(result.rows[0].one).toBe(1);
  });

  it('gives each caller its own database', async () => {
    const other = await createTestDatabase();
    try {
      await db.pool.query('create table only_here (id int)');
      await expect(other.pool.query('select * from only_here')).rejects.toThrow(
        /does not exist/,
      );
    } finally {
      await other.close();
    }
  });
});
