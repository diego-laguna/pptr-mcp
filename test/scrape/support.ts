import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import { SitesRepository } from '../../src/catalog/sites.repository.js';
import { clothingSchema } from '../support/fixtures.js';
import { TestDatabase } from '../support/test-database.js';

export async function createSite(db: TestDatabase, name = 'Owner') {
  const customers = new CustomersRepository(db.pool);
  const catalogs = new CatalogsRepository(db.pool);
  const sites = new SitesRepository(db.pool);
  const customer = await customers.create(name);
  const catalog = await catalogs.create(customer.id, 'kids', clothingSchema);
  const site = await sites.add(customer.id, catalog.id, {
    url: `https://${name.toLowerCase()}.example`,
    name: 'Shop',
    country: 'AR',
    currency: 'ARS',
  });
  return { customer, catalog, site };
}
