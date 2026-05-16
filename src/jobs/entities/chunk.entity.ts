import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
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
  summary: string;

  @ManyToOne(() => Job, (job) => job.chunks)
  job: Job;
}
