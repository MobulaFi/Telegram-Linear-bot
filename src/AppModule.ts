
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import LinearTrackerBotConfig from './config/LinearBotConfig.js';
import LinearTrackerBot from './services/LinearBotService.js';
import AIService from './services/AIService.js';
import { LinearWebhookController } from './controller/LinearWebhookController.js';
import { RedisModule } from './redis/redisModule.js';

@Module({
  imports: [
    ConfigModule.forRoot({
       isGlobal: true,
      validate: (unsafeConfig) => LinearTrackerBotConfig.parse(unsafeConfig),
    }),
    RedisModule
  ],
  controllers: [LinearWebhookController],
  providers: [AIService, LinearTrackerBot],
})
export default class AppModule {}
