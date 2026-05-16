import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity()
@Index(['key', 'resourceType'], { unique: true })
export class Idempotency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  key: string;

  @Column()
  resourceId: string; // jobId

  @Column()
  resourceType: string; // "job"

  @CreateDateColumn()
  createdAt: Date;
}
