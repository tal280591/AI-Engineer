import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiModule } from './ai/ai.module';
import { ChunksModule } from './chunks/chunks.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USER || 'ai',
      password: process.env.DB_PASS || 'ai',
      database: process.env.DB_NAME || 'ai_doc_analyzer',

      autoLoadEntities: true,
      synchronize: true, // OK for now. Later: migrations.
      logging: false,
    }),

    BullModule.forRoot({
      connection: { host: 'localhost', port: 6379 },
    }),

    AiModule,
    JobsModule,
    ChunksModule,
  ],
})
export class AppModule {}
