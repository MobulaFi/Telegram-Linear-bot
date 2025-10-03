import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { LinearAuthGuard } from 'src/guard/LinearAuthGuard';
import LinearTrackerBot from 'src/services/LinearBotService';

interface LinearWebhookPayload {
  action: string;
  type?: string;
  data: any;
}

@Controller()
export class LinearWebhookController {
  constructor(
    @Inject(LinearTrackerBot) private readonly linearTrackerBot: LinearTrackerBot,
  ) {}

  @Post('linear-webhook')
  @UseGuards(LinearAuthGuard)
  handle(@Body() data: LinearWebhookPayload) {
    console.log('Webhook received:', data);

    // Process asynchronously so we can return immediately
    setImmediate(async () => {
      try {
        if (data.action === 'update') {
          const { id, state } = data.data;
          if (state?.name) {
            await this.linearTrackerBot.updateIssueStatuss(id, state.name);
          }
        }

        if (data.action === 'create' && data.type === 'Comment') {
          const { body, issue, user, createdAt } = data.data;
          if (body && issue?.id && user?.name) {
            await this.linearTrackerBot.updateIssueStatuss(issue.id, '', {
              text: body,
              author: user.name,
              date: createdAt,
            });
          }
        }
      } catch (err) {
        console.error('Error processing Linear webhook:', err);
      }
    });

    return 'ok';
  }
}
