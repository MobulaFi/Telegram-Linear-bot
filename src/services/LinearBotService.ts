import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { type Context, Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/types';
import type LinearTrackerBotConfig from 'src/config/LinearBotConfig';
import type Redis from 'ioredis';
import AIService from './AIService';

interface TelegramLinearIssue {
  chatId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  team: string;
  issueId: string;
  identifier: string;
  title: string;
  description?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  comments?: { text: string; author: string; createdAt: string }[];
}

@Injectable()
export default class LinearTrackerBot {
  private bot?: Telegraf<Context>;
  private isLaunched = false;
  private botUsername?: string;

  private allowedUsernames: Set<string>;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<LinearTrackerBotConfig, true>,
    @Inject('REDIS') private readonly redis: Redis,
    @Inject(AIService) private readonly aiService: AIService,
  ) {
    const usernames = this.config.get<string>('TELEGRAM_ALLOWED_USERNAMES') || '';
    console.log('Whitelisted usernames from env:', usernames);
    this.allowedUsernames = new Set(usernames.split(',').map((u) => u.trim()).filter(Boolean));
  }

  private get brandName(): string {
    const isHawk = this.config.get<boolean>('IS_HAWK');
    return isHawk ? 'Hawk' : 'Mobula';
  }

  private get commandName(): string {
    const isHawk = this.config.get<boolean>('IS_HAWK');
    return isHawk ? 'hawkticket' : 'ticket';
  }


  private parseComments(raw?: string): { text: string; author: string; createdAt: string }[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (c): c is { text: string; author: string; createdAt: string } =>
          typeof c === 'object' &&
          c !== null &&
          'text' in c &&
          'author' in c &&
          'createdAt' in c &&
          // biome-ignore lint/suspicious/noExplicitAny: <any>
          typeof (c as any).text === 'string' &&
          // biome-ignore lint/suspicious/noExplicitAny: <any>
          typeof (c as any).author === 'string' &&
          // biome-ignore lint/suspicious/noExplicitAny: <any>
          typeof (c as any).createdAt === 'string',
      );
    } catch {
      return [];
    }
  }

  private formatDate(dateString: string): string {
    if (!dateString) return 'Unknown';

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMinutes = Math.floor(diffMs / (1000 * 60));

      if (diffDays === 0) {
        if (diffHours === 0) {
          if (diffMinutes === 0) return 'Just now';
          return `${diffMinutes}m ago`;
        }
        return `${diffHours}h ago`;
      }

      if (diffDays < 7) {
        return `${diffDays}d ago`;
      }

      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    } catch (error) {
      console.error(error);
      return 'Invalid date';
    }
  }


  async launchBot() {
    if (this.isLaunched) return;
    this.isLaunched = true;

    console.info('Starting Telegram bot...');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('❌ TELEGRAM_BOT_TOKEN is not set in environment variables');
      return;
    }
    console.log("Custom Token", `${token.slice(0, 5)}...${token.slice(-5)}`);
    this.bot = new Telegraf(token);
    console.log('Telegram bot instance created');

    console.log("Allowed usernames:", Array.from(this.allowedUsernames).join(', '));

    // Start command
    this.bot.start((ctx) => {
      // const welcomeMsg = `🚀 <b>Welcome to Mobula Super Bot!</b>
      const welcomeMsg = `🚀 <b>Welcome to ${this.brandName} Super Bot!</b>

<b>Available Commands:</b>
/ticket &lt;title&gt; | &lt;description&gt; — Create a new ticket
/help — Show this help message

Ready to track your tickets! 📝`;

      ctx.reply(welcomeMsg, { parse_mode: 'HTML' });
    });

    // Help command
   this.bot.command('help', (ctx) => {
  const helpMsg = `📖 <b>${this.brandName} Super Bot Help</b>

<b>Commands:</b>
/ticket &lt;title&gt; | &lt;description&gt; — Create issue
<i>Example: /ticket Fix login bug | Users can't login on mobile</i>

💡 <b>Tips:</b>
• Use | to separate title and description`;

  ctx.reply(helpMsg, { parse_mode: 'HTML' });
});


    // Ticket command
    this.bot.command('ticket', async (ctx) => {
      const args = ctx.message.text.replace('/ticket', '').trim();

      if (!args) {
    return ctx.reply(
      `❌ <b>Usage:</b> /ticket &lt;title&gt; | &lt;description&gt;
\n\n<b>Example:</b>\n/ticket Fix login issue | Users unable to authenticate`,
      { parse_mode: 'HTML' },
    );
  }
      const username = ctx.from?.username;

      if (!username || !this.allowedUsernames.has(username)) {
        return ctx.reply(
          '❌ You are not authorized to create issues.\nPlease contact the admin to get access.',
          { parse_mode: 'HTML' },
        );
      }

      const [titlePart, ...descParts] = args.split('|');
      const title = (titlePart ?? '').trim();
      const description = descParts.join('|').trim() || '';
      const team = ctx.chat.type === 'private' ? ctx.from?.username || 'PrivateChat' : ctx.chat.title || 'UnknownGroup';

      console.debug(`Creating issue: ${title} - ${description}`);

      const creatingMsg = await ctx.reply('⏳ Creating Ticket...', { parse_mode: 'HTML' });

      try {
        const mutation = `
        mutation {
          issueCreate(input: {
            title: "${title}",
            description: "${description}",
            teamId: "${this.config.get('LINEAR_TEAM_ID')}"
          }) {
            success
            issue {
              id
              identifier
              title
              state { name }
            }
          }
        }`;

        const res = await axios.post(
          this.config.get('LINEAR_API_URL'),
          { query: mutation },
          {
            headers: {
              Authorization: `${this.config.get('LINEAR_API_KEY')}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const issue = res.data.data?.issueCreate?.issue;

        if (!issue) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            creatingMsg.message_id,
            undefined,
            '❌ <b>Failed to create Ticket</b>\nPlease try again later.',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const issueData: TelegramLinearIssue = {
          chatId: ctx.chat.id,
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
          team,
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description,
          status: issue.state?.name || 'Open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await this.redis.hset(`issue:${issue.id}`, issueData);
        await this.redis.sadd(`chat:${ctx.chat.id}:issues`, issue.id);

        // Success message safely in HTML
        const successMsg = `✅ <b>Issue Created Successfully!</b> ${issue.identifier} — ${issue.title}`;

        await ctx.telegram.editMessageText(ctx.chat.id, creatingMsg.message_id, undefined, successMsg, {
          parse_mode: 'HTML',
        });
      } catch (err: unknown) {
        const error = err as { response?: { data?: unknown }; message?: string };
        console.error('Error creating Ticket issue', error?.response?.data || error?.message);

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          creatingMsg.message_id,
          undefined,
          '<b>Failed to create ticket issue</b>\nPlease check your configuration and try again.',
          { parse_mode: 'HTML' },
        );
      }
    });

    // Handle mentions for AI-powered ticket operations
    this.bot.on('message', async (ctx) => {
      const message = ctx.message as Message.TextMessage;
      
      // Store message in chat history for context (keep last 20 messages)
      if ('text' in message) {
        const chatHistoryKey = `chat:${ctx.chat.id}:history`;
        const msgData = JSON.stringify({
          from: ctx.from?.username || ctx.from?.first_name || 'Unknown',
          text: message.text,
          timestamp: message.date,
        });
        await this.redis.lpush(chatHistoryKey, msgData);
        await this.redis.ltrim(chatHistoryKey, 0, 19); // Keep only last 20 messages
        await this.redis.expire(chatHistoryKey, 3600); // Expire after 1 hour
      }
      
      if (!('text' in message)) {
        return;
      }

      const text = message.text;
      const botMentioned = this.isBotMentioned(text, message);

      if (!botMentioned) {
        return;
      }

      const username = ctx.from?.username;
      if (!username || !this.allowedUsernames.has(username)) {
        return ctx.reply(
          '❌ You are not authorized to use this bot.\nPlease contact the admin to get access.',
          { parse_mode: 'HTML' },
        );
      }

      // Remove bot mention from message
      const cleanMessage = this.removeBotMention(text);
      if (!cleanMessage.trim()) {
        return ctx.reply(
          `💡 <b>How to use me:</b>\n\n` +
          `📝 <b>Create:</b> <i>"create a ticket for Sandy to fix the login bug"</i>\n` +
          `✏️ <b>Edit:</b> <i>"edit this ticket"</i> or <i>"edit MOB-1234"</i>\n` +
          `❌ <b>Cancel:</b> <i>"cancel this ticket"</i>\n` +
          `👤 <b>Assign:</b> <i>"assign this ticket to Cyril"</i>\n` +
          `📊 <b>Status:</b> <i>"set this ticket to In Progress"</i>`,
          { parse_mode: 'HTML' },
        );
      }

      const processingMsg = await ctx.reply('🤖 Analyzing your request...', { parse_mode: 'HTML' });

      try {
        // Get recent tickets from this chat for context
        const chatIssuesKey = `chat:${ctx.chat.id}:issues`;
        const recentIssueIds = await this.redis.smembers(chatIssuesKey);
        const recentTickets: string[] = [];
        
        for (const issueId of recentIssueIds.slice(0, 5)) {
          const issueData = await this.redis.hgetall(`issue:${issueId}`);
          if (issueData?.identifier) {
            recentTickets.push(`${issueData.identifier}: ${issueData.title || 'No title'}`);
          }
        }

        // Get chat history for context
        const chatHistoryKey = `chat:${ctx.chat.id}:history`;
        const historyRaw = await this.redis.lrange(chatHistoryKey, 0, 19);
        const chatHistory = historyRaw
          .map((h) => {
            try {
              return JSON.parse(h) as { from: string; text: string; timestamp: number };
            } catch {
              return null;
            }
          })
          .filter((h): h is { from: string; text: string; timestamp: number } => h !== null)
          .reverse();

        // Get reply-to message if exists
        let replyContext = '';
        const replyToMessage = (message as Message.TextMessage & { reply_to_message?: Message.TextMessage }).reply_to_message;
        if (replyToMessage && 'text' in replyToMessage) {
          replyContext = `\n\n[Replying to message from ${replyToMessage.from?.username || replyToMessage.from?.first_name || 'Unknown'}]: "${replyToMessage.text}"`;
        }

        // Build context string
        let contextString = '';
        if (chatHistory.length > 1) {
          contextString = '\n\n--- Recent chat history ---\n';
          contextString += chatHistory
            .slice(0, -1)
            .map((h) => `${h.from}: ${h.text}`)
            .join('\n');
          contextString += '\n--- End of history ---';
        }

        const fullContext = cleanMessage + replyContext + contextString;

        // Parse the command using AI
        const command = await this.aiService.parseCommand(fullContext, recentTickets);

        if (!command || command.confidence < 0.5) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            `❌ <b>Could not understand your request</b>\n\nTry something like:\n` +
            `<i>"Create a ticket for Sandy to fix the login bug"</i>\n` +
            `<i>"Cancel this ticket"</i>\n` +
            `<i>"Assign MOB-1234 to Cyril"</i>`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        // Handle different actions
        switch (command.action) {
          case 'edit':
            await this.handleEditAction(ctx, processingMsg.message_id, command.ticketIdentifier, command.editField, command.newValue, command.assigneeName);
            break;
          case 'cancel':
            await this.handleCancelAction(ctx, processingMsg.message_id, command.ticketIdentifier);
            break;
          case 'delete':
            await this.handleDeleteAction(ctx, processingMsg.message_id, command.ticketIdentifier);
            break;
          case 'assign':
            await this.handleAssignAction(ctx, processingMsg.message_id, command.ticketIdentifier, command.assigneeName);
            break;
          case 'status':
            await this.handleStatusAction(ctx, processingMsg.message_id, command.ticketIdentifier, command.newStatus);
            break;
          case 'create':
          default:
            await this.handleCreateAction(ctx, processingMsg.message_id, command);
            break;
        }
      } catch (err) {
        console.error('Error processing command:', err);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          '❌ <b>An error occurred</b>\nPlease try again.',
          { parse_mode: 'HTML' },
        );
      }
    });

    // Handle Edit button callback - show menu
    this.bot.action(/^edit_(.+)$/, async (ctx) => {
      const username = ctx.from?.username;
      if (!this.isUserAuthorized(username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }

      const issueIdentifier = ctx.match[1];
      
      await ctx.answerCbQuery();
      await ctx.reply(
        `✏️ <b>Edit Ticket ${issueIdentifier}</b>\n\nWhat would you like to edit?`,
        { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📌 Title', callback_data: `editfield_title_${issueIdentifier}` },
                { text: '📝 Description', callback_data: `editfield_desc_${issueIdentifier}` },
              ],
              [
                { text: '👤 Assignee', callback_data: `editfield_assignee_${issueIdentifier}` },
                { text: '📊 Status', callback_data: `editfield_status_${issueIdentifier}` },
              ],
              [
                { text: '🔗 Open in Linear', url: `https://linear.app/mobulalabs/issue/${issueIdentifier}` },
              ],
            ],
          },
        },
      );
    });

    // Handle edit field selection - Title
    this.bot.action(/^editfield_title_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueIdentifier = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `📌 <b>Edit Title for ${issueIdentifier}</b>\n\nReply to this message with the new title, or use:\n<code>@${this.botUsername} edit titre ${issueIdentifier} : New Title</code>`,
        { parse_mode: 'HTML' },
      );
      // Store pending edit in Redis
      await this.redis.setex(`pending_edit:${ctx.chat!.id}`, 300, JSON.stringify({ 
        field: 'title', 
        identifier: issueIdentifier 
      }));
    });

    // Handle edit field selection - Description
    this.bot.action(/^editfield_desc_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueIdentifier = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `📝 <b>Edit Description for ${issueIdentifier}</b>\n\nReply to this message with the new description, or use:\n<code>@${this.botUsername} edit description ${issueIdentifier} : New description</code>`,
        { parse_mode: 'HTML' },
      );
      await this.redis.setex(`pending_edit:${ctx.chat!.id}`, 300, JSON.stringify({ 
        field: 'description', 
        identifier: issueIdentifier 
      }));
    });

    // Handle edit field selection - Assignee
    this.bot.action(/^editfield_assignee_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueIdentifier = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `👤 <b>Change Assignee for ${issueIdentifier}</b>\n\nUse:\n<code>@${this.botUsername} assign ${issueIdentifier} to [name]</code>\n\nExample: <code>@${this.botUsername} assign ${issueIdentifier} to florent</code>`,
        { parse_mode: 'HTML' },
      );
    });

    // Handle edit field selection - Status
    this.bot.action(/^editfield_status_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueIdentifier = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.reply(
        `📊 <b>Change Status for ${issueIdentifier}</b>\n\nSelect new status:`,
        { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📋 Todo', callback_data: `setstatus_Todo_${issueIdentifier}` },
                { text: '🔄 In Progress', callback_data: `setstatus_In Progress_${issueIdentifier}` },
              ],
              [
                { text: '👀 In Review', callback_data: `setstatus_In Review_${issueIdentifier}` },
                { text: '✅ Done', callback_data: `setstatus_Done_${issueIdentifier}` },
              ],
            ],
          },
        },
      );
    });

    // Handle status change from menu
    this.bot.action(/^setstatus_(.+)_([A-Z]+-\d+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const newStatus = ctx.match[1];
      const issueIdentifier = ctx.match[2];
      
      await ctx.answerCbQuery('Updating status...');
      
      try {
        const issueId = await this.getIssueIdFromIdentifier(issueIdentifier);
        if (!issueId) {
          await ctx.editMessageText(`❌ <b>Ticket ${issueIdentifier} not found</b>`, { parse_mode: 'HTML' });
          return;
        }

        const stateId = await this.getStateIdByName(newStatus);
        if (!stateId) {
          await ctx.editMessageText(`❌ <b>Status "${newStatus}" not found</b>`, { parse_mode: 'HTML' });
          return;
        }

        const mutation = `
          mutation {
            issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) {
              success
              issue { state { name } }
            }
          }`;

        const res = await axios.post(
          this.config.get('LINEAR_API_URL'),
          { query: mutation },
          {
            headers: {
              Authorization: this.config.get('LINEAR_API_KEY'),
              'Content-Type': 'application/json',
            },
          },
        );

        if (res.data.data?.issueUpdate?.success) {
          await ctx.editMessageText(
            `✅ <b>Ticket ${issueIdentifier} updated to "${newStatus}"</b>`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.editMessageText(`❌ <b>Failed to update status</b>`, { parse_mode: 'HTML' });
        }
      } catch (err) {
        console.error('Failed to update status from menu:', err);
        await ctx.editMessageText(`❌ <b>Error updating status</b>`, { parse_mode: 'HTML' });
      }
    });

    // Handle Done button callback - delete message and show minimal confirmation
    this.bot.action(/^done_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueIdentifier = ctx.match[1];
      const linearUrl = `https://linear.app/mobulalabs/issue/${issueIdentifier}`;
      
      try {
        await ctx.answerCbQuery('Done!');
        // Delete the original message
        await ctx.deleteMessage();
        // Send a minimal confirmation
        await ctx.reply(
          `✅ <b>Done</b> — <a href="${linearUrl}">${issueIdentifier}</a>`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } catch (err) {
        console.error('Failed to handle done action:', err);
        await ctx.answerCbQuery('Could not process');
      }
    });

    // Handle Cancel button callback
    this.bot.action(/^cancel_(.+)$/, async (ctx) => {
      if (!this.isUserAuthorized(ctx.from?.username)) {
        await ctx.answerCbQuery('❌ You are not authorized', { show_alert: true });
        return;
      }
      const issueId = ctx.match[1];
      
      try {
        const mutation = `
          mutation {
            issueArchive(id: "${issueId}") {
              success
            }
          }`;

        const res = await axios.post(
          this.config.get('LINEAR_API_URL'),
          { query: mutation },
          {
            headers: {
              Authorization: this.config.get('LINEAR_API_KEY'),
              'Content-Type': 'application/json',
            },
          },
        );

        if (res.data.data?.issueArchive?.success) {
          await ctx.answerCbQuery('Ticket cancelled!');
          await ctx.editMessageText(
            '🗑️ <b>Ticket Cancelled</b>\n\nThis ticket has been archived.',
            { parse_mode: 'HTML' },
          );
          await this.redis.del(`issue:${issueId}`);
        } else {
          await ctx.answerCbQuery('Failed to cancel ticket');
        }
      } catch (err) {
        console.error('Failed to cancel ticket:', err);
        await ctx.answerCbQuery('Error cancelling ticket');
      }
    });

    this.bot.catch((err) => {
      console.error('Telegram bot error:', err);
    });

    try {
      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username;
      console.info(`Bot username: @${this.botUsername}`);
      
      // Retry logic for Railway deployments - wait for old instance to stop
      const maxRetries = 5;
      const retryDelayMs = 3000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.bot.launch();
          console.info(`Telegram bot @${this.botUsername} polling started.`);
          break;
        } catch (launchErr: unknown) {
          const isConflict = launchErr instanceof Error && launchErr.message.includes('409');
          if (isConflict && attempt < maxRetries) {
            console.warn(`Bot launch attempt ${attempt}/${maxRetries} failed (conflict), retrying in ${retryDelayMs}ms...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          } else {
            throw launchErr;
          }
        }
      }
    } catch (err: unknown) {
      console.error('Failed to launch Telegram bot', err);
    }
  }

  // Action handlers
  private async handleEditAction(
    ctx: Context,
    messageId: number,
    ticketIdentifier: string | null,
    editField: string | null,
    newValue: string | null,
    assigneeName: string | null,
  ): Promise<void> {
    if (!ticketIdentifier) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the ticket</b>\n\nPlease specify the ticket (e.g., "edit MOB-1234")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    // If no specific field or "menu", show interactive menu
    if (!editField || editField === 'menu') {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        `✏️ <b>Edit Ticket ${ticketIdentifier}</b>\n\nWhat would you like to edit?`,
        { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📌 Title', callback_data: `editfield_title_${ticketIdentifier}` },
                { text: '📝 Description', callback_data: `editfield_desc_${ticketIdentifier}` },
              ],
              [
                { text: '👤 Assignee', callback_data: `editfield_assignee_${ticketIdentifier}` },
                { text: '📊 Status', callback_data: `editfield_status_${ticketIdentifier}` },
              ],
              [
                { text: '🔗 Open in Linear', url: `https://linear.app/mobulalabs/issue/${ticketIdentifier}` },
              ],
            ],
          },
        },
      );
      return;
    }

    // Direct edit with field and value
    try {
      const issueId = await this.getIssueIdFromIdentifier(ticketIdentifier);
      if (!issueId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Ticket ${ticketIdentifier} not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      let mutation = '';
      let successField = '';

      switch (editField) {
        case 'title':
          if (!newValue) {
            await ctx.telegram.editMessageText(
              ctx.chat!.id,
              messageId,
              undefined,
              '❌ <b>Please provide a new title</b>',
              { parse_mode: 'HTML' },
            );
            return;
          }
          const escapedTitle = newValue.replace(/"/g, '\\"');
          mutation = `
            mutation {
              issueUpdate(id: "${issueId}", input: { title: "${escapedTitle}" }) {
                success
                issue { title }
              }
            }`;
          successField = 'title';
          break;

        case 'description':
          const escapedDesc = (newValue || '').replace(/"/g, '\\"');
          mutation = `
            mutation {
              issueUpdate(id: "${issueId}", input: { description: "${escapedDesc}" }) {
                success
                issue { description }
              }
            }`;
          successField = 'description';
          break;

        case 'assignee':
          const assigneeId = assigneeName ? await this.aiService.getUserIdByName(assigneeName) : null;
          if (!assigneeId) {
            await ctx.telegram.editMessageText(
              ctx.chat!.id,
              messageId,
              undefined,
              `❌ <b>User "${assigneeName || newValue}" not found</b>`,
              { parse_mode: 'HTML' },
            );
            return;
          }
          mutation = `
            mutation {
              issueUpdate(id: "${issueId}", input: { assigneeId: "${assigneeId}" }) {
                success
                issue { assignee { name } }
              }
            }`;
          successField = 'assignee';
          break;

        case 'status':
          const stateId = await this.getStateIdByName(newValue || '');
          if (!stateId) {
            await ctx.telegram.editMessageText(
              ctx.chat!.id,
              messageId,
              undefined,
              `❌ <b>Status "${newValue}" not found</b>\n\nAvailable: Todo, In Progress, In Review, Done`,
              { parse_mode: 'HTML' },
            );
            return;
          }
          mutation = `
            mutation {
              issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) {
                success
                issue { state { name } }
              }
            }`;
          successField = 'status';
          break;

        default:
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            messageId,
            undefined,
            '❌ <b>Unknown field to edit</b>',
            { parse_mode: 'HTML' },
          );
          return;
      }

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      if (res.data.data?.issueUpdate?.success) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `✅ <b>Ticket ${ticketIdentifier} ${successField} updated!</b>`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Failed to update ${successField}</b>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('Failed to edit ticket:', err);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Error editing ticket</b>',
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleDeleteAction(
    ctx: Context,
    messageId: number,
    ticketIdentifier: string | null,
  ): Promise<void> {
    if (!ticketIdentifier) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the ticket</b>\n\nPlease specify the ticket (e.g., "delete MOB-1234")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const issueId = await this.getIssueIdFromIdentifier(ticketIdentifier);
      if (!issueId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Ticket ${ticketIdentifier} not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // Permanently delete the issue
      const mutation = `
        mutation {
          issueDelete(id: "${issueId}") {
            success
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      if (res.data.data?.issueDelete?.success) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `🗑️ <b>Ticket ${ticketIdentifier} Permanently Deleted</b>\n\n⚠️ This action cannot be undone.`,
          { parse_mode: 'HTML' },
        );
        await this.redis.del(`issue:${issueId}`);
        await this.redis.srem(`chat:${ctx.chat!.id}:issues`, issueId);
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Failed to delete ticket ${ticketIdentifier}</b>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('Failed to delete ticket:', err);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Error deleting ticket</b>',
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleCancelAction(
    ctx: Context,
    messageId: number,
    ticketIdentifier: string | null,
  ): Promise<void> {
    if (!ticketIdentifier) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the ticket</b>\n\nPlease specify the ticket (e.g., "cancel MOB-1234")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      // First get the issue ID from identifier
      const issueId = await this.getIssueIdFromIdentifier(ticketIdentifier);
      if (!issueId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Ticket ${ticketIdentifier} not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const mutation = `
        mutation {
          issueArchive(id: "${issueId}") {
            success
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      if (res.data.data?.issueArchive?.success) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `🗑️ <b>Ticket ${ticketIdentifier} Cancelled</b>\n\nThis ticket has been archived.`,
          { parse_mode: 'HTML' },
        );
        await this.redis.del(`issue:${issueId}`);
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Failed to cancel ticket ${ticketIdentifier}</b>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('Failed to cancel ticket:', err);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Error cancelling ticket</b>',
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleAssignAction(
    ctx: Context,
    messageId: number,
    ticketIdentifier: string | null,
    assigneeName: string | null,
  ): Promise<void> {
    if (!ticketIdentifier) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the ticket</b>\n\nPlease specify the ticket (e.g., "assign MOB-1234 to Cyril")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (!assigneeName) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the assignee</b>\n\nPlease specify who to assign (e.g., "assign MOB-1234 to Cyril")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const issueId = await this.getIssueIdFromIdentifier(ticketIdentifier);
      if (!issueId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Ticket ${ticketIdentifier} not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const assigneeId = await this.aiService.getUserIdByName(assigneeName);
      if (!assigneeId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>User "${assigneeName}" not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const mutation = `
        mutation {
          issueUpdate(id: "${issueId}", input: { assigneeId: "${assigneeId}" }) {
            success
            issue { assignee { name } }
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      if (res.data.data?.issueUpdate?.success) {
        const newAssignee = res.data.data.issueUpdate.issue?.assignee?.name || assigneeName;
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `✅ <b>Ticket ${ticketIdentifier} assigned to ${newAssignee}</b>`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Failed to assign ticket ${ticketIdentifier}</b>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('Failed to assign ticket:', err);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Error assigning ticket</b>',
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleStatusAction(
    ctx: Context,
    messageId: number,
    ticketIdentifier: string | null,
    newStatus: string | null,
  ): Promise<void> {
    if (!ticketIdentifier) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the ticket</b>\n\nPlease specify the ticket (e.g., "set MOB-1234 to In Progress")',
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (!newStatus) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not identify the status</b>\n\nAvailable: Todo, In Progress, In Review, Done, Cancelled',
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const issueId = await this.getIssueIdFromIdentifier(ticketIdentifier);
      if (!issueId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Ticket ${ticketIdentifier} not found</b>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // Get workflow states for the team
      const stateId = await this.getStateIdByName(newStatus);
      if (!stateId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Status "${newStatus}" not found</b>\n\nAvailable: Todo, In Progress, In Review, Done, Cancelled`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const mutation = `
        mutation {
          issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) {
            success
            issue { state { name } }
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      if (res.data.data?.issueUpdate?.success) {
        const updatedStatus = res.data.data.issueUpdate.issue?.state?.name || newStatus;
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `✅ <b>Ticket ${ticketIdentifier} updated to "${updatedStatus}"</b>`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          messageId,
          undefined,
          `❌ <b>Failed to update ticket ${ticketIdentifier}</b>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (err) {
      console.error('Failed to update ticket status:', err);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Error updating ticket status</b>',
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleCreateAction(
    ctx: Context,
    messageId: number,
    command: { title: string | null; description: string | null; assigneeName: string | null },
  ): Promise<void> {
    if (!command.title) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Could not determine ticket title</b>\n\nPlease be more specific about what the ticket should be.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    let assigneeId: string | null = null;
    if (command.assigneeName) {
      assigneeId = await this.aiService.getUserIdByName(command.assigneeName);
    }

    // Build description with Telegram context
    const chatType = ctx.chat!.type;
    const chatName = chatType === 'private' 
      ? `Private chat with ${ctx.from?.username || ctx.from?.first_name || 'Unknown'}`
      : (ctx.chat as { title?: string }).title || 'Unknown Group';
    
    // Build message reference (no clickable link for private groups - Telegram limitation)
    const message = ctx.message as { message_id?: number };
    
    // Build full description with context
    let fullDescription = command.description || '';
    fullDescription += '\n\n---\n';
    fullDescription += `**Context:** ${chatName}`;
    if (message.message_id) {
      fullDescription += ` (Message #${message.message_id})`;
    }
    fullDescription += `\n**Requested by:** @${ctx.from?.username || ctx.from?.first_name || 'Unknown'}`;

    const issue = await this.createLinearIssue(
      command.title,
      fullDescription,
      assigneeId,
    );

    if (!issue) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        '❌ <b>Failed to create ticket</b>\nPlease try again later.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const team = chatType === 'private' 
      ? ctx.from?.username || 'PrivateChat' 
      : chatName;

    // Store in Redis
    const issueData: TelegramLinearIssue = {
      chatId: ctx.chat!.id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      team,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: command.description || '',
      status: issue.state?.name || 'Open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.redis.hset(`issue:${issue.id}`, issueData);
    await this.redis.sadd(`chat:${ctx.chat!.id}:issues`, issue.id);

    // Build comprehensive success message
    const linearUrl = `https://linear.app/mobulalabs/issue/${issue.identifier}`;
    const requestedBy = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'Unknown';
    const createdAt = new Date().toLocaleString('en-US', { 
      dateStyle: 'medium', 
      timeStyle: 'short' 
    });

    // Get the actual assignee name from the Linear response if available
    const actualAssignee = issue.assignee?.name || command.assigneeName || 'Unassigned';

    let successMsg = `✅ <b>Ticket Created Successfully!</b>\n\n`;
    successMsg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    successMsg += `🎫 <b>Ticket:</b> <a href="${linearUrl}">${issue.identifier}</a>\n`;
    successMsg += `📌 <b>Title:</b> ${issue.title}\n`;
    successMsg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    successMsg += `📝 <b>Description:</b>\n<i>${command.description || 'No description'}</i>\n\n`;
    
    successMsg += `👤 <b>Assigned to:</b> ${actualAssignee}\n`;
    successMsg += `📊 <b>Status:</b> ${issue.state?.name || 'Todo'}\n`;
    successMsg += `🙋 <b>Requested by:</b> ${requestedBy}\n`;
    successMsg += `🕐 <b>Created at:</b> ${createdAt}\n\n`;
    
    successMsg += `🔗 <a href="${linearUrl}">View in Linear</a>`;

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      messageId,
      undefined,
      successMsg,
      { 
        parse_mode: 'HTML', 
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✏️ Edit', callback_data: `edit_${issue.identifier}` },
              { text: '❌ Cancel', callback_data: `cancel_${issue.id}` },
            ],
            [
              { text: '✅ Done', callback_data: `done_${issue.identifier}` },
            ],
          ],
        },
      },
    );
  }

  private async getIssueIdFromIdentifier(identifier: string): Promise<string | null> {
    try {
      const query = `
        query {
          issue(id: "${identifier}") {
            id
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      return res.data.data?.issue?.id || null;
    } catch (err) {
      console.error('Failed to get issue ID from identifier:', err);
      return null;
    }
  }

  private async getStateIdByName(statusName: string): Promise<string | null> {
    try {
      const query = `
        query {
          workflowStates(filter: { team: { id: { eq: "${this.config.get('LINEAR_TEAM_ID')}" } } }) {
            nodes {
              id
              name
            }
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      const states = res.data.data?.workflowStates?.nodes as { id: string; name: string }[] | undefined;
      if (!states) return null;

      const normalizedStatus = statusName.toLowerCase().trim();
      const matchedState = states.find((s) => s.name.toLowerCase() === normalizedStatus);
      return matchedState?.id || null;
    } catch (err) {
      console.error('Failed to get state ID by name:', err);
      return null;
    }
  }

  private isUserAuthorized(username: string | undefined): boolean {
    return !!username && this.allowedUsernames.has(username);
  }

  private isBotMentioned(text: string, message: Message.TextMessage): boolean {
    // Check for @username mention
    if (this.botUsername && text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`)) {
      return true;
    }

    // Check for entity mentions
    const entities = message.entities || [];
    for (const entity of entities) {
      if (entity.type === 'mention') {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        if (this.botUsername && mentionText.toLowerCase() === `@${this.botUsername.toLowerCase()}`) {
          return true;
        }
      }
    }

    return false;
  }

  private removeBotMention(text: string): string {
    if (!this.botUsername) return text;
    const regex = new RegExp(`@${this.botUsername}`, 'gi');
    return text.replace(regex, '').trim();
  }

  private escapeGraphQLString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  private async createLinearIssue(
    title: string,
    description: string,
    assigneeId: string | null,
  ): Promise<{ id: string; identifier: string; title: string; state?: { name: string }; assignee?: { id: string; name: string } } | null> {
    try {
      const escapedTitle = this.escapeGraphQLString(title);
      const escapedDescription = this.escapeGraphQLString(description);
      
      let mutation = `
        mutation {
          issueCreate(input: {
            title: "${escapedTitle}",
            description: "${escapedDescription}",
            teamId: "${this.config.get('LINEAR_TEAM_ID')}"`;
      
      if (assigneeId) {
        mutation += `,
            assigneeId: "${assigneeId}"`;
      }
      
      mutation += `
          }) {
            success
            issue {
              id
              identifier
              title
              state { name }
              assignee { id name }
            }
          }
        }`;

      const res = await axios.post(
        this.config.get('LINEAR_API_URL'),
        { query: mutation },
        {
          headers: {
            Authorization: this.config.get('LINEAR_API_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      return res.data.data?.issueCreate?.issue || null;
    } catch (err) {
      console.error('Failed to create Linear issue:', err);
      return null;
    }
  }


  private getProgressBar(status: string): string {
    const statusOrder = ['Todo', 'In Progress', 'Pipeline Running', 'In Review', 'To Deploy', 'To QA', 'Done'];

    const totalBlocks = 5;
    const index = statusOrder.indexOf(status);
    const progress = index >= 0 ? Math.round(((index + 1) / statusOrder.length) * 100) : 0;
    const filledBlocks = Math.round((progress / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

    return `${progressBar} ${progress}%`;
  }

  async testRedis() {
    try {
      await this.redis.set('test_key', 'hello');
      const value = await this.redis.get('test_key');
      return value === 'hello';
    } catch (err) {
      console.error('Redis test failed:', err);
      return false;
    }
  }


  async updateIssueStatuss(issueId: string, status: string, comment?: { text: string; author: string; date?: string }) {
    const data = await this.redis.hgetall(`issue:${issueId}`);
    if (!Object.keys(data).length) return;

    console.debug('Updating issue from Redis', data);

    const comments = this.parseComments(data.comments);

    if (comment) {
      comments.push({
        text: comment.text,
        author: comment.author,
        createdAt: comment.date || new Date().toISOString(),
      });
    }

    const issue: TelegramLinearIssue = {
      chatId: Number.parseInt(data.chatId || '0', 10),
      username: data.username || '',
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      team: data.team || '',
      issueId: data.issueId || '',
      identifier: data.identifier || '',
      title: data.title || '',
      description: data.description || '',
      status,
      createdAt: data.createdAt || '',
      updatedAt: new Date().toISOString(),
      comments,
    };

    const redisData = { ...issue, comments: JSON.stringify(issue.comments) };
    await this.redis.hset(`issue:${issueId}`, redisData);

    const progressBar = this.getProgressBar(status);

    let msg = "🎫 *Ticket Updated*\n\n";
    msg += `*${issue.identifier}* — ${issue.title}\n`;

    msg += `*Status:* ${status}\n`;
    msg += `${progressBar}\n`;

    if (comment) {
      msg += `*Comment by ${comment.author}:*\n${comment.text}\n`;
    }

    msg += `\n_Updated on: ${this.formatDate(issue.updatedAt)}_`;

    try {
      if (!this.bot) throw new Error('Telegram bot not initialized');
      await this.bot.telegram.sendMessage(issue.chatId, msg, { parse_mode: 'Markdown' });
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Failed to send Telegram update message', err.message);
      } else {
        console.error('Failed to send Telegram update message', String(err));
      }
    }
  }
}
