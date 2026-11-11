import { Module } from '@nestjs/common';
import { ArrivalsController } from './arrivals.controller.js';
import { ArrivalsService } from './arrivals.service.js';

@Module({ controllers: [ArrivalsController], providers: [ArrivalsService] })
export class ArrivalsModule {}
