import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ScrapeConfig } from './scrape.config.js';
import { SCRAPE_CONFIG } from './tokens.js';

/** Internal endpoints require `Authorization: Bearer <INTERNAL_API_TOKEN>`. */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    @Inject(SCRAPE_CONFIG)
    private readonly config: Pick<ScrapeConfig, 'internalApiToken'>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const header = request.headers['authorization'];
    if (!header) throw new UnauthorizedException();
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(this.config.internalApiToken);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    )
      throw new ForbiddenException();
    return true;
  }
}
