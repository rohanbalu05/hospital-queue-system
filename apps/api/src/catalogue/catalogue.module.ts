import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller.js';

@Module({ controllers: [CatalogueController] })
export class CatalogueModule {}
