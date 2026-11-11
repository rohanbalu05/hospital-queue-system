import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { FollowUpController, MyFollowUpsController } from './followup.controller.js';
import { FollowUpService } from './followup.service.js';

@Module({
  imports: [SchedulingModule],
  controllers: [FollowUpController, MyFollowUpsController],
  providers: [FollowUpService],
  exports: [FollowUpService],
})
export class FollowUpModule {}
