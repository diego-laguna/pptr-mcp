# Tech Stack

- **Runtime:** Node.js
- **Package manager:** pnpm
- **Language:** TypeScript
- **Framework:** NestJS (Fastify adapter)
- **Database:** PostgreSQL (RDS on AWS), accessed with `pg` and plain SQL; no ORM
- **Migrations:** `node-pg-migrate`, SQL files in `migrations/` (`pnpm migrate:up`, `pnpm migrate:down`)
- **Testing:** Vitest; integration tests run against a real PostgreSQL started by Testcontainers (`@testcontainers/postgresql`, needs Docker; `pnpm test:int`)
- **Data model:** multi-tenant — customers own catalogs, each with a customer-defined, versioned schema (see `docs/persistence.md`)
- **Browser automation:** Puppeteer, via Puppeteer MCP
- **Scrape execution:** declarative selector specs run by a fixed runner on `puppeteer-core` (+ `@sparticuz/chromium` on Lambda); AWS SQS (FIFO scrape queue), S3 (specs and raw results), EventBridge Scheduler (per-site schedules), Lambda container image with a Fargate fallback (see `docs/scrape-execution.md`)
- **Infrastructure as code:** AWS CDK (TypeScript) in `infra/`, with its own `package.json` (`cd infra && pnpm test`)
