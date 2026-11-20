import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { NotificationsLogController } from './notifications-log.controller.js';
import { SystemController } from './system.controller.js';

@Module({ controllers: [AdminController, NotificationsLogController, SystemController] })
export class AdminModule {}
