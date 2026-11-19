import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { NotFoundError } from '../catalog/errors.js';
import {
  DiscoveryRequestService,
  InvalidDiscoveryRequestError,
  NoBaseSpecError,
} from '../discovery/api/discovery-request.service.js';
import { SpecVersionsRepository } from '../discovery/api/spec-versions.repository.js';
import { InternalAuthGuard } from '../scrape/api/internal-auth.guard.js';
import {
  NoActiveSpecError,
  ScrapeRequestService,
} from '../scrape/api/scrape-request.service.js';
import { ActivationService } from './activation.service.js';
import {
  ActivationConflictError,
  ActivationValidationError,
} from './errors.js';
import { ReviewService } from './review.service.js';
import { ScheduleService } from './schedule.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Until accounts exist the owning customer arrives as a trusted internal header. */
function customerOf(header: string | undefined): string {
  if (!header || !UUID.test(header))
    throw new BadRequestException('X-Customer-Id must be a customer id');
  return header;
}

function translate(error: unknown): never {
  if (error instanceof NotFoundError)
    throw new NotFoundException(error.message);
  if (error instanceof ActivationConflictError)
    throw new ConflictException({ code: error.code, message: error.message });
  if (error instanceof NoActiveSpecError)
    throw new ConflictException({ code: error.code, message: error.message });
  if (error instanceof NoBaseSpecError)
    throw new ConflictException({ code: error.code, message: error.message });
  if (error instanceof ActivationValidationError)
    throw new UnprocessableEntityException({
      code: error.code,
      message: error.message,
      properties: error.properties,
    });
  if (error instanceof InvalidDiscoveryRequestError)
    throw new UnprocessableEntityException(error.message);
  throw error;
}

@Controller('internal/sites/:siteId')
@UseGuards(InternalAuthGuard)
export class InternalActivationController {
  constructor(
    @Inject(ActivationService) private readonly activations: ActivationService,
    @Inject(ScheduleService) private readonly schedules: ScheduleService,
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Inject(SpecVersionsRepository)
    private readonly versions: SpecVersionsRepository,
    @Inject(ScrapeRequestService)
    private readonly scrapes: ScrapeRequestService,
    @Inject(DiscoveryRequestService)
    private readonly discoveries: DiscoveryRequestService,
  ) {}

  @Post('activations')
  @HttpCode(200)
  async activate(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body()
    body: {
      version?: unknown;
      expectedCurrent?: unknown;
      acknowledge?: unknown;
      cadence?: { expression?: unknown; timezone?: unknown };
      approvedBy?: unknown;
    },
  ) {
    const customerId = customerOf(customer);
    const { version, expectedCurrent, acknowledge } = body ?? {};
    if (!Number.isInteger(version) || (version as number) < 1)
      throw new BadRequestException('version must be a positive integer');
    if (
      expectedCurrent !== null &&
      expectedCurrent !== undefined &&
      !Number.isInteger(expectedCurrent)
    )
      throw new BadRequestException(
        'expectedCurrent must be a version number or null',
      );
    if (
      acknowledge !== undefined &&
      (!Array.isArray(acknowledge) ||
        !acknowledge.every((a) => typeof a === 'string'))
    )
      throw new BadRequestException(
        'acknowledge must be a list of property names',
      );
    try {
      const { record, changed } = await this.activations.activate({
        customerId,
        siteId,
        version: version as number,
        expectedCurrent: (expectedCurrent as number | null | undefined) ?? null,
        acknowledge: acknowledge as string[] | undefined,
        cadence: body.cadence,
        approvedBy:
          typeof body.approvedBy === 'string' ? body.approvedBy : null,
      });
      return { activation: record, changed };
    } catch (error) {
      translate(error);
    }
  }

  @Get('activations')
  async history(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
  ) {
    try {
      return {
        activations: await this.activations.history(
          customerOf(customer),
          siteId,
        ),
      };
    } catch (error) {
      translate(error);
    }
  }

  @Get('spec-versions')
  async list(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
  ) {
    const customerId = customerOf(customer);
    try {
      return {
        activeVersion: await this.activations.activeVersion(customerId, siteId),
        versions: await this.versions.list(customerId, siteId),
      };
    } catch (error) {
      translate(error);
    }
  }

  @Get('spec-versions/:version/review')
  async review(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    try {
      return await this.reviews.review(customerOf(customer), siteId, version);
    } catch (error) {
      translate(error);
    }
  }

  @Post('spec-versions/:version/discard')
  @HttpCode(200)
  async discard(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    try {
      await this.activations.discard(customerOf(customer), siteId, version);
      return { discarded: true };
    } catch (error) {
      translate(error);
    }
  }

  /** Requests a fresh preview, for example after a failed one or once the stored sample expired. */
  @Post('spec-versions/:version/previews')
  @HttpCode(202)
  async preview(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    try {
      await this.versions.get(customerOf(customer), siteId, version);
      const { runId } = await this.scrapes.request({
        mode: 'preview',
        siteId,
        specVersion: version,
      });
      return { runId };
    } catch (error) {
      translate(error);
    }
  }

  /**
   * Retry discovery from a review with new guidance. The reviewed candidate and
   * the catalog schema are left alone; `incremental` extends the reviewed version.
   */
  @Post('spec-versions/:version/retry')
  @HttpCode(202)
  async retry(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: { guidance?: unknown; mode?: unknown; properties?: unknown },
  ) {
    const customerId = customerOf(customer);
    const mode = body?.mode ?? 'full';
    if (mode !== 'full' && mode !== 'incremental')
      throw new BadRequestException('mode must be full or incremental');
    try {
      await this.versions.get(customerId, siteId, version);
      const { attemptId } = await this.discoveries.request({
        siteId,
        mode,
        guidance: body?.guidance as string | undefined,
        properties: body?.properties as string[] | undefined,
        ...(mode === 'incremental' ? { baseVersion: version } : {}),
      });
      return { attemptId };
    } catch (error) {
      translate(error);
    }
  }

  @Put('schedule')
  async changeSchedule(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() body: { expression?: unknown; timezone?: unknown },
  ) {
    try {
      return await this.schedules.change(
        customerOf(customer),
        siteId,
        body ?? {},
      );
    } catch (error) {
      translate(error);
    }
  }

  @Get('schedule')
  async getSchedule(
    @Headers('x-customer-id') customer: string | undefined,
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
  ) {
    try {
      const cadence = await this.schedules.get(customerOf(customer), siteId);
      if (!cadence) throw new NotFoundError('schedule');
      return cadence;
    } catch (error) {
      translate(error);
    }
  }
}
