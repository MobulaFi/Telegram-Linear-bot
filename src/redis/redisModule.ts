// src/redis/redis.module.ts
import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS',
      useFactory: () => {
        return new Redis(process.env.REDIS_PRIMARY_URL || 'redis://localhost:6379');
      },
    },
  ],
  exports: ['REDIS'],
})
export class RedisModule {}
