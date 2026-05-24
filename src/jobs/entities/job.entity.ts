import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { Chunk } from './chunk.entity';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

@Entity()
export class Job {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ default: 'pending' })
  status: JobStatus;

  @Column({ default: 0 })
  totalChunks: number;

  @Column({ default: 0 })
  completedChunks: number;

  @Column({ default: 0 })
  totalInputTokens: number;

  @Column({ default: 0 })
  totalOutputTokens: number;

  @Column({ nullable: true, type: 'text' })
  finalSummary: string | null;

  @Column({ nullable: true, type: 'text' })
  lastError: string | null;

  @Column({ nullable: true, type: 'timestamptz' })
  startedAt: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  completedAt: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  failedAt: Date | null;

  @OneToMany(() => Chunk, (chunk) => chunk.job)
  chunks: Chunk[];
}
