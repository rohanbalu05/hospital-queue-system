import { Module } from '@nestjs/common';
import { MyVisitsController } from './my-visits.controller.js';
import { PatientsController } from './patients.controller.js';

@Module({ controllers: [PatientsController, MyVisitsController] })
export class PatientsModule {}
