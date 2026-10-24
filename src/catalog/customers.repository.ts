import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { ValidationFailedError } from './errors.js';
import { Customer } from './types.js';

@Injectable()
export class CustomersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async create(name: string): Promise<Customer> {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ValidationFailedError('a customer needs a name', [
        { path: 'name', code: 'missing_name', message: 'a name is required' },
      ]);
    }
    const { rows } = await this.pool.query(
      'INSERT INTO customers (name) VALUES ($1) RETURNING id, name, created_at',
      [name.trim()],
    );
    return toCustomer(rows[0]);
  }

  async get(id: string): Promise<Customer | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, name, created_at FROM customers WHERE id = $1',
      [id],
    );
    return rows[0] ? toCustomer(rows[0]) : undefined;
  }
}

function toCustomer(row: any): Customer {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
