import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller.js';

@Module({ controllers: [PatientsController] })
export class PatientsModule {}
