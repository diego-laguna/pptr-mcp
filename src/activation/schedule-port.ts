import { Cadence } from './cadence.js';

/** One recurring schedule per site, mirroring the cadence stored in the database. */
export interface SchedulePort {
  upsert(siteId: string, cadence: Cadence): Promise<void>;
  remove(siteId: string): Promise<void>;
  /** Ids of the sites that currently have a schedule. */
  listSiteIds(): Promise<string[]>;
}
