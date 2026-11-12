import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
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
import { AssistantModule } from './assistant/assistant.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { FollowUpModule } from './followup/followup.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { ReportsModule } from './reports/reports.module.js';

@Module({
  imports: [
    CoreModule,
    ProvidersModule,
    AccessModule,
    IdentityModule,
    PatientsModule,
    CatalogueModule,
    SchedulingModule,
    ArrivalsModule,
    QueueModule,
    LiveModule,
    AuditModule,
    AdminModule,
    FollowUpModule,
    DocumentsModule,
    AssistantModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
