import { Controller, Post, Body, Get, Param, Headers } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  async create(
    @Body('text') text: string,
    @Headers('idempotency-key') idemKey: string,
  ) {
    return this.jobsService.createJob(text, { idempotencyKey: idemKey });
  }

  @Get(':id')
  async getStatus(@Param('id') id: string) {
    return this.jobsService.getJob(id);
  }
}
