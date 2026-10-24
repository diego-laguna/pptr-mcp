import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { NotFoundError } from '../../catalog/errors.js';
import { InternalAuthGuard } from '../../scrape/api/internal-auth.guard.js';
import {
  BudgetExhaustedError,
  DiscoveryRequestService,
  InvalidDiscoveryRequestError,
  NoBaseSpecError,
} from './discovery-request.service.js';

@Controller('internal/sites/:siteId/discoveries')
@UseGuards(InternalAuthGuard)
export class InternalDiscoveryController {
  constructor(
    @Inject(DiscoveryRequestService)
    private readonly requests: DiscoveryRequestService,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() body: { mode?: unknown; properties?: unknown; guidance?: unknown },
  ) {
    try {
      const { attemptId } = await this.requests.request({
        siteId,
        mode: (body?.mode ?? 'full') as never,
        properties: body?.properties as never,
        guidance: body?.guidance as never,
      });
      return { attemptId };
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new NotFoundException(error.message);
      if (error instanceof InvalidDiscoveryRequestError)
        throw new UnprocessableEntityException(error.message);
      if (error instanceof NoBaseSpecError)
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      if (error instanceof BudgetExhaustedError)
        throw new HttpException(
          { reason: error.reason, message: error.message },
          429,
        );
      throw error;
    }
  }
}
