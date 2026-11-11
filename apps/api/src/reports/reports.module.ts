import { Module } from '@nestjs/common';
import { NotificationsController, ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({ controllers: [ReportsController, NotificationsController], providers: [ReportsService] })
export class ReportsModule {}
