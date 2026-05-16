import { Entity, PrimaryColumn, Column, OneToMany } from 'typeorm';
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

  @Column({ nullable: true })
  finalSummary: string;

  @OneToMany(() => Chunk, (chunk) => chunk.job)
  chunks: Chunk[];
}
