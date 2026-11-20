import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { NotificationsLogController } from './notifications-log.controller.js';

@Module({ controllers: [AdminController, NotificationsLogController] })
export class AdminModule {}
