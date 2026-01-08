import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type LinearTrackerBotConfig from 'src/config/LinearBotConfig';
import { USER_MAPPINGS, findLinearUserByIdentifier } from 'src/config/userMappings';

interface LinearUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
}

interface ParsedTicketRequest {
  title: string;
  description: string;
  assigneeName: string | null;
  confidence: number;
}

@Injectable()
export default class AIService {
  private linearUsers: LinearUser[] = [];
  private usersLastFetched = 0;
  private readonly USERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<LinearTrackerBotConfig, true>,
  ) {}

  private async fetchLinearUsers(): Promise<LinearUser[]> {
    const now = Date.now();
    if (this.linearUsers.length > 0 && now - this.usersLastFetched < this.USERS_CACHE_TTL) {
      return this.linearUsers;
    }

    try {
      const query = `{ users { nodes { id name displayName email } } }`;
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

      const users = res.data.data?.users?.nodes as LinearUser[] | undefined;
      if (users) {
        this.linearUsers = users;
        this.usersLastFetched = now;
      }
      return this.linearUsers;
    } catch (err) {
      console.error('Failed to fetch Linear users:', err);
      return this.linearUsers;
    }
  }

  async parseTicketRequest(message: string): Promise<ParsedTicketRequest | null> {
    await this.fetchLinearUsers();
    
    // Build user list with all aliases for better matching
    const userListForAI = USER_MAPPINGS.map((u) => 
      `- ${u.linearName} (aliases: ${u.aliases.join(', ')}, telegram: @${u.telegramUsername})`
    ).join('\n');

    const systemPrompt = `You are an assistant that parses Telegram messages to extract ticket information for Linear.
    
Available team members for assignment (use the linearName for assigneeName):
${userListForAI}

Your task is to extract:
1. A concise title for the ticket (max 100 chars)
2. A detailed description with all relevant context
3. The assignee name - MUST be the exact linearName from the list above (e.g., "florent", "cyril", "morgan", etc.)

Respond ONLY with valid JSON in this exact format:
{
  "title": "string",
  "description": "string", 
  "assigneeName": "string or null",
  "confidence": 0.0 to 1.0
}

Rules:
- If the message doesn't seem like a ticket request, set confidence to 0
- Match assignee by any of their aliases, telegram username, or name. Return the linearName.
  Examples: "flo", "florent", "@Flouflof" -> assigneeName: "florent"
            "sandy", "sanjay", "@Sandy0209" -> assigneeName: "sanjay"
            "cyril", "coco", "@cocyril" -> assigneeName: "cyril"
            "morgan", "@Mrg77i" -> assigneeName: "morgan"
            "teo", "@NBMXyeu" -> assigneeName: "teo"
            "sacha", "@NBMSacha" -> assigneeName: "sacha"
            "delox", "sachadelox", "@sacha_xyz" -> assigneeName: "sachadelox"
- If no assignee is mentioned, set assigneeName to null
- Keep the title short and actionable
- **IMPORTANT**: The message may include chat history for context. Use ALL the context from the conversation to create a meaningful title and detailed description.
- If someone says "create a ticket for this" or "make a ticket about that", look at the chat history to understand what "this" or "that" refers to.
- Include all relevant details from the conversation in the description.
- The description should be comprehensive and explain the full context of the issue.`;

    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          temperature: 0.3,
          max_tokens: 500,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.get('OPENAI_API_KEY')}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const content = res.data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as ParsedTicketRequest;
      
      // Validate and match assignee
      if (parsed.assigneeName) {
        const matchedUser = this.findUserByName(parsed.assigneeName);
        if (matchedUser) {
          parsed.assigneeName = matchedUser.name;
        } else {
          parsed.assigneeName = null;
        }
      }

      return parsed;
    } catch (err) {
      console.error('Failed to parse ticket request with AI:', err);
      return null;
    }
  }

  private findUserByName(name: string): LinearUser | null {
    const normalizedName = name.toLowerCase().trim();
    
    // First, try to find via our custom mapping
    const mapping = findLinearUserByIdentifier(normalizedName);
    if (mapping) {
      // Find the Linear user by email from our mapping
      const linearUser = this.linearUsers.find(
        (u) => u.email.toLowerCase() === mapping.linearEmail.toLowerCase()
      );
      if (linearUser) {
        return linearUser;
      }
    }
    
    // Fallback to direct Linear user search
    return this.linearUsers.find((user) => {
      const userName = user.name.toLowerCase();
      const displayName = user.displayName.toLowerCase();
      const emailPrefix = user.email.split('@')[0].toLowerCase();
      
      return (
        userName.includes(normalizedName) ||
        displayName.includes(normalizedName) ||
        normalizedName.includes(userName) ||
        normalizedName.includes(displayName) ||
        emailPrefix.includes(normalizedName) ||
        normalizedName.includes(emailPrefix)
      );
    }) ?? null;
  }

  async getUserIdByName(name: string): Promise<string | null> {
    await this.fetchLinearUsers();
    const user = this.findUserByName(name);
    return user?.id ?? null;
  }

  // Get display name for Telegram message (from our mapping)
  getDisplayNameForUser(linearName: string): string {
    const mapping = findLinearUserByIdentifier(linearName);
    return mapping?.linearName ?? linearName;
  }

  getLinearUsers(): LinearUser[] {
    return this.linearUsers;
  }
}

