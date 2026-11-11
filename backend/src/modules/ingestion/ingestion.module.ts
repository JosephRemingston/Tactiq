import { Module } from '@nestjs/common';
import { CanonicalWriter } from './canonical.writer';
import { INGESTION_HANDLERS } from './ingestion.handlers';
import { IngestionService } from './ingestion.service';
import { RawPayloadStore } from './raw-payload.store';

@Module({ providers: [RawPayloadStore, CanonicalWriter, IngestionService, ...INGESTION_HANDLERS], exports: [IngestionService, CanonicalWriter, RawPayloadStore] })
export class IngestionModule {}
