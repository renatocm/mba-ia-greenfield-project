import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { StatusService } from './status.service';

@SkipThrottle()
@Controller('status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Public()
  @Get()
  getStatus() {
    return this.statusService.getStatus();
  }
}
