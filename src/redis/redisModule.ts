// src/redis/redis.module.ts
import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS',
      useFactory: () => {
        const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
          connectTimeout: 10000, // 10s timeout
          retryStrategy(times) {
            const delay = Math.min(times * 50, 2000); // exponential backoff
            console.warn(`Redis reconnect attempt #${times}, retrying in ${delay}ms`);
            return delay;
          },
        });

        client.on('connect', () => {
          console.log('✅ Redis connected');
        });

        client.on('error', (err) => {
          console.error('❌ Redis error:', err);
        });

        return client;
      },
    },
  ],
  exports: ['REDIS'],
})
export class RedisModule {}
