import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Job } from './job.entity';

export type ChunkStatus = 'pending' | 'running' | 'completed' | 'failed';

@Entity()
export class Chunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  index: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ default: 'pending' })
  status: ChunkStatus;

  @Column({ nullable: true, type: 'text' })
  summary: string | null;

  @Column({ default: 0 })
  attempts: number;

  @Column({ default: 3 })
  maxAttempts: number;

  @Column({ nullable: true, type: 'text' })
  lastError: string | null;

  @Column({ nullable: true, type: 'timestamptz' })
  startedAt: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  completedAt: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  failedAt: Date | null;

  @Column({ default: 0 })
  inputTokens: number;

  @Column({ default: 0 })
  outputTokens: number;

  @ManyToOne(() => Job, (job) => job.chunks)
  job: Job;
}
