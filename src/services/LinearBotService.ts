import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { type Context, Telegraf } from 'telegraf';
import type LinearTrackerBotConfig from 'src/config/LinearBotConfig';
import Redis from 'ioredis';

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

  private allowedUsernames: Set<string>;

constructor(
  @Inject(ConfigService) private readonly config: ConfigService<LinearTrackerBotConfig, true>,
  @Inject('REDIS') private readonly redis: Redis,
) {
  const usernames = this.config.get<string>('TELEGRAM_ALLOWED_USERNAMES') || '';
  console.log('Whitelisted usernames from env:', usernames);
  this.allowedUsernames = new Set(usernames.split(',').map((u) => u.trim()).filter(Boolean));
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

  const token = process.env.TELEGRAM_ROOM_BOT_TOKEN;
  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in environment variables');
    return;
  }
  console.log("Custom Token", token.slice(0, 5) + '...' + token.slice(-5));
  this.bot = new Telegraf(token);
  console.log('Telegram bot instance created');

  console.log("Allowed usernames:", Array.from(this.allowedUsernames).join(', '));

  // Start command
  this.bot.start((ctx) => {
    const welcomeMsg = `🚀 <b>Welcome to Mobula Super Bot!</b>

<b>Available Commands:</b>
/ticket &lt;title&gt; | &lt;description&gt; — Create a new ticket
/help — Show this help message

Ready to track your tickets! 📝`;

    ctx.reply(welcomeMsg, { parse_mode: 'HTML' });
  });

  // Help command
  this.bot.command('help', (ctx) => {
    const helpMsg = `📖 <b>Mobula Super Bot Help</b>

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
        '❌ <b>Usage:</b> /ticket &lt;title&gt; | &lt;description&gt;\n\n<b>Example:</b>\n/ticket Fix login issue | Users unable to authenticate',
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

  this.bot.catch((err) => {
    console.error('Telegram bot error:', err);
  });

  try {
    await this.bot.launch();
    console.info('Telegram bot polling started.');
  } catch (err: unknown) {
    console.error('Failed to launch Telegram bot', err);
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
