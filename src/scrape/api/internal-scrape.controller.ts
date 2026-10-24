import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { NotFoundError } from '../../catalog/errors.js';
import { InternalAuthGuard } from './internal-auth.guard.js';
import {
  NoActiveSpecError,
  productionRequest,
  ScrapeRequestService,
} from './scrape-request.service.js';

@Controller('internal/sites/:siteId')
@UseGuards(InternalAuthGuard)
export class InternalScrapeController {
  constructor(
    @Inject(ScrapeRequestService)
    private readonly requests: ScrapeRequestService,
  ) {}

  @Post('refresh')
  @HttpCode(202)
  async refresh(@Param('siteId', new ParseUUIDPipe()) siteId: string) {
    return this.run(productionRequest(siteId));
  }

  @Post('preview')
  @HttpCode(202)
  async preview(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() body: { specVersion?: unknown },
  ) {
    const specVersion = body?.specVersion;
    if (
      typeof specVersion !== 'number' ||
      !Number.isInteger(specVersion) ||
      specVersion < 1
    )
      throw new BadRequestException('specVersion must be a positive integer');
    return this.run({ mode: 'preview', siteId, specVersion });
  }

  private async run(request: Parameters<ScrapeRequestService['request']>[0]) {
    try {
      const { runId } = await this.requests.request(request);
      return { runId };
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new NotFoundException(error.message);
      if (error instanceof NoActiveSpecError)
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      throw error;
    }
  }
}
