import { loadDatabaseConfig } from './database.config.js';

describe('loadDatabaseConfig', () => {
  it('fails fast with a clear error when DATABASE_URL is missing', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL is not set/);
  });

  it('treats a blank DATABASE_URL as missing', () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: '   ' })).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  it('reads the connection string and defaults the pool size', () => {
    expect(
      loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' }),
    ).toEqual({
      connectionString: 'postgres://u:p@localhost/db',
      poolMax: 10,
    });
  });

  it('reads a custom pool size', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgres://u:p@localhost/db',
      DATABASE_POOL_MAX: '4',
    });
    expect(config.poolMax).toBe(4);
  });

  it.each(['0', '-1', 'abc', '2.5'])('rejects pool size %s', (value) => {
    expect(() =>
      loadDatabaseConfig({
        DATABASE_URL: 'postgres://u:p@localhost/db',
        DATABASE_POOL_MAX: value,
      }),
    ).toThrow(/DATABASE_POOL_MAX/);
  });
});
