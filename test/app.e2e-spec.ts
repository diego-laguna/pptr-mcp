import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    // The pool connects lazily, so a placeholder URL is enough for this test.
    process.env.SCRAPE_QUEUE_URL ??= 'http://localhost/scrape.fifo';
    process.env.RESULTS_QUEUE_URL ??= 'http://localhost/results';
    process.env.FAILED_SCRAPE_QUEUE_URL ??= 'http://localhost/failed';
    process.env.TRIGGER_QUEUE_URL ??= 'http://localhost/trigger';
    process.env.RESULTS_BUCKET ??= 'placeholder';
    process.env.INTERNAL_API_TOKEN ??= 'placeholder';
    process.env.AWS_REGION ??= 'us-east-1';
    process.env.DATABASE_URL ??= 'postgres://placeholder@localhost:5432/none';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer() as App)
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
