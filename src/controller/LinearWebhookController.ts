import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { LinearAuthGuard } from 'src/guard/LinearAuthGuard';
import LinearTrackerBot from 'src/services/LinearBotService';

interface LinearWebhookPayload {
  action: string;
  type?: string;
  // biome-ignore lint/suspicious/noExplicitAny: <any>
  data: any;
}

@Controller()
export class LinearWebhookController {
  private lastProcessedState = new Map<string, string>();
  constructor(
    @Inject(LinearTrackerBot) private readonly linearTrackerBot: LinearTrackerBot,
  ) { }

  @Post('linear-webhook')
  @UseGuards(LinearAuthGuard)
  handle(@Body() data: LinearWebhookPayload) {

    console.log('Webhook received:', data);
    setImmediate(async () => {
      try {
        if (data.action === 'update') {
          const { id, identifier, state } = data.data;
          const stateName = state?.name;

          if (!id || !identifier || !stateName) return;
          if (this.lastProcessedState.get(identifier) === stateName) return;
          this.lastProcessedState.set(identifier, stateName);

          await this.linearTrackerBot.updateIssueStatuss(id, stateName);
        }

        if (data.action === 'create' && data.type === 'Comment') {
          const { body, issue, user, createdAt } = data.data;
          if (body && issue?.id && user?.name) {
            await this.linearTrackerBot.updateIssueStatuss(issue.id, '', {
              text: body,
              author: user.name,
              date: createdAt,
            });
          };
        }
      } catch (err) {
        console.error('Error processing Linear webhook:', err);
      }
    });
    return 'ok';
  }
}
