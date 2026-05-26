import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

// Migration CLI uses the privileged DATABASE_URL (creates roles, grants, etc).
// The running NestJS service uses DATABASE_URL_APP (the meridian_markets_app
// role, which has no UPDATE/DELETE on treasury_movements).
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'],
  synchronize: false,
  logging: process.env['NODE_ENV'] !== 'production',
  entities: [],
  migrations: ['migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
