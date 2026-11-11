import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { LiveModule } from './live/live.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AccessModule } from './access/access.module.js';
import { ArrivalsModule } from './arrivals/arrivals.module.js';
import { CatalogueModule } from './catalogue/catalogue.module.js';
import { CoreModule } from './common/db.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';

@Module({
  imports: [
    CoreModule,
    AccessModule,
    IdentityModule,
    PatientsModule,
    CatalogueModule,
    SchedulingModule,
    ArrivalsModule,
    QueueModule,
    LiveModule,
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
