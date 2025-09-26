import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { LinearAuthGuard } from 'src/guard/LinearAuthGuard';
import LinearTrackerBot from 'src/services/LinearBotService';

interface LinearWebhookPayload {
  action: string;
  type?: string;
  // biome-ignore lint/suspicious/noExplicitAny: <not sure the exact type here>
  data: any;
}

@Controller()
export class LinearWebhookController {
  constructor(
    @Inject(LinearTrackerBot) private readonly linearTrackerBot: LinearTrackerBot,
  ) {}

  @Post('linear-webhook')
  @UseGuards(LinearAuthGuard)
  async handle(@Body() data: LinearWebhookPayload) {

    if (data.action === 'update') {
      const getId = data.data.id;
      const getState = data.data.state;
      await this.linearTrackerBot.updateIssueStatuss(getId, getState.name);
    }

    if (data.action === 'create' && data.type === 'Comment') {
      const commentText = data.data.body;
      const issueId = data.data.issue.id;
      const sender = data.data.user.name;
      const timestamp = data.data.createdAt;

      await this.linearTrackerBot.updateIssueStatuss(issueId, '', {
        text: commentText,
        author: sender,
        date: timestamp,
      });
    }

    return 'ok';
  }
}