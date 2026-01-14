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

type ActionType = 'create' | 'edit' | 'cancel' | 'delete' | 'assign' | 'status';
type EditField = 'title' | 'description' | 'assignee' | 'status' | 'menu' | null;

interface ParsedCommand {
  action: ActionType;
  ticketIdentifier: string | null; // e.g., "MOB-1234" or null for create
  assigneeName: string | null;
  newStatus: string | null;
  title: string | null;
  description: string | null;
  editField: EditField; // What field to edit (for edit action)
  newValue: string | null; // New value for the field being edited
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

    const systemPrompt = `You are an expert technical writer creating Linear tickets from Telegram conversations.
    
Available team members for assignment (use the linearName for assigneeName):
${userListForAI}

Your task is to extract:
1. A clear, actionable title (max 100 chars) - should describe WHAT needs to be done
2. A COMPREHENSIVE description that includes ALL relevant context
3. The assignee name - MUST be the exact linearName from the list above

Respond ONLY with valid JSON in this exact format:
{
  "title": "string",
  "description": "string", 
  "assigneeName": "string or null",
  "confidence": 0.0 to 1.0
}

CRITICAL RULES FOR DESCRIPTION:
- The description MUST be detailed and comprehensive (at least 2-3 sentences minimum)
- Include the full context of WHY this ticket is needed
- Include any technical details, URLs, error messages, or specifics mentioned
- If there's chat history, summarize the relevant discussion that led to this ticket
- Structure the description with clear sections if needed:
  • Context/Background
  • What needs to be done
  • Any specific requirements or constraints
  • Related information from the conversation
- NEVER write just "No description" or a single sentence unless the request is truly trivial
- If the request is vague, ask clarifying questions in the description

ASSIGNEE MATCHING:
- Match by any alias, telegram username, or name. Return the linearName.
  Examples: "flo", "florent", "@Flouflof" -> assigneeName: "florent"
            "sandy", "sanjay", "@Sandy0209" -> assigneeName: "sanjay"
            "cyril", "coco", "@cocyril" -> assigneeName: "cyril"
            "morgan", "@Mrg77i" -> assigneeName: "morgan"
            "teo", "@NBMXyeu" -> assigneeName: "teo"
            "sacha", "@NBMSacha" -> assigneeName: "sacha"
            "delox", "sachadelox", "@sacha_xyz" -> assigneeName: "sachadelox"
- If no assignee is mentioned, set assigneeName to null

TITLE RULES:
- Keep it short but descriptive (action + object)
- Use imperative mood: "Fix X", "Add Y", "Update Z"
- Don't include assignee name in title

CONTEXT HANDLING:
- The message may include chat history. Use ALL context to create a meaningful ticket.
- If someone says "create a ticket for this", look at the chat history to understand what "this" refers to.
- Include relevant quotes or details from the conversation in the description.`;

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
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.error('Failed to parse ticket request with AI:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
      return null;
    }
  }

  private findUserByName(name: string): LinearUser | null {
    const normalizedName = name.toLowerCase().trim().replace('@', '');
    console.log(`[AIService] findUserByName: looking for "${normalizedName}"`);
    
    // First, try to find via our custom mapping
    const mapping = findLinearUserByIdentifier(normalizedName);
    console.log(`[AIService] Mapping found:`, mapping);
    
    if (mapping) {
      // Find the Linear user by email from our mapping
      const linearUser = this.linearUsers.find(
        (u) => u.email.toLowerCase() === mapping.linearEmail.toLowerCase()
      );
      if (linearUser) {
        console.log(`[AIService] Found via mapping email match:`, linearUser.email);
        return linearUser;
      }
      
      // Fallback: try to find by name if email doesn't match
      const byName = this.linearUsers.find(
        (u) => u.name.toLowerCase().includes(mapping.linearName.toLowerCase()) ||
               mapping.linearName.toLowerCase().includes(u.name.toLowerCase())
      );
      if (byName) {
        console.log(`[AIService] Found via mapping name match:`, byName.name);
        return byName;
      }
    }
    
    // Fallback to direct Linear user search
    const directMatch = this.linearUsers.find((user) => {
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
    
    console.log(`[AIService] Direct match result:`, directMatch?.name ?? 'null');
    return directMatch;
  }

  async getUserIdByName(name: string): Promise<string | null> {
    await this.fetchLinearUsers();
    console.log(`[AIService] getUserIdByName called with: "${name}"`);
    console.log(`[AIService] Available Linear users:`, this.linearUsers.map(u => ({ name: u.name, email: u.email, id: u.id })));
    
    const user = this.findUserByName(name);
    console.log(`[AIService] Found user:`, user ? { name: user.name, email: user.email, id: user.id } : null);
    
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

  async parseCommand(message: string, recentTickets: string[]): Promise<ParsedCommand | null> {
    await this.fetchLinearUsers();
    
    const userListForAI = USER_MAPPINGS.map((u) => 
      `- ${u.linearName} (aliases: ${u.aliases.join(', ')}, telegram: @${u.telegramUsername})`
    ).join('\n');

    const ticketContext = recentTickets.length > 0 
      ? `Recent tickets mentioned in this chat:\n${recentTickets.join('\n')}`
      : 'No recent tickets in context.';

    const systemPrompt = `You are an expert technical writer that parses Telegram messages to understand what action the user wants to perform on Linear tickets.

Available actions:
- "create": Create a new ticket (USE THIS when user wants to CREATE/MAKE a NEW ticket)
- "edit": Edit an existing ticket (can edit title, description, assignee, or status directly)
- "cancel": Cancel/archive an existing ticket (recoverable)
- "delete": Permanently delete a ticket (IRREVERSIBLE)
- "assign": Change the assignee of an EXISTING ticket (shortcut for edit assignee) - ONLY use if a specific ticket ID like MOB-1234 is mentioned
- "status": Change the status of an EXISTING ticket (shortcut for edit status) - ONLY use if a specific ticket ID like MOB-1234 is mentioned

=== CRITICAL: DISTINGUISHING "create" vs "assign" ===

RULE: If NO ticket identifier (like MOB-1234) is mentioned, it's ALWAYS a "create" action!

Examples of CREATE (no existing ticket ID):
- "assign me a ticket to do X" → action: "create" (NEW ticket assigned to speaker)
- "can you assign me a ticket for X" → action: "create" (NEW ticket)
- "assign Sacha a ticket to X" → action: "create" (NEW ticket assigned to Sacha)
- "assign a ticket to @Flouflof on X" → action: "create" (NEW ticket assigned to Flouflof)
- "can you assign a ticket to Sandy for Y" → action: "create" (NEW ticket)
- "create a ticket for Cyril to do Z" → action: "create" (NEW ticket)

Examples of ASSIGN (EXISTING ticket ID mentioned):
- "assign MOB-1234 to Cyril" → action: "assign" (changing assignee of EXISTING ticket)
- "assign this ticket to Morgan" → action: "assign" (if there's a recent ticket in context)
- "reassign MOB-567 to Sandy" → action: "assign"

KEY PATTERNS:
- "assign [PERSON] a ticket" = CREATE new ticket
- "assign a ticket to [PERSON]" = CREATE new ticket  
- "assign [TICKET-ID] to [PERSON]" = ASSIGN existing ticket

Available team members for assignment:
${userListForAI}

Available statuses: Todo, In Progress, In Review, Done, Cancelled

${ticketContext}

Respond ONLY with valid JSON in this exact format:
{
  "action": "create" | "edit" | "cancel" | "delete" | "assign" | "status",
  "ticketIdentifier": "MOB-1234 or null",
  "assigneeName": "linearName or null",
  "newStatus": "status name or null",
  "title": "ticket title for create action or null",
  "description": "ticket description for create action or null",
  "editField": "title" | "description" | "assignee" | "status" | "menu" | null,
  "newValue": "the new value for the field being edited or null",
  "confidence": 0.0 to 1.0
}

=== CRITICAL RULES FOR "create" ACTION ===

TITLE:
- Keep it short but descriptive (max 100 chars)
- Use imperative mood: "Move X to Y", "Fix X", "Add Y", "Update Z"
- Don't include assignee name in title

DESCRIPTION - THIS IS CRITICAL:
- The description MUST be detailed and comprehensive (minimum 2-3 sentences)
- NEVER leave description empty, null, or just "No description"
- Structure it like this:
  
  **Context:** Why is this needed? What's the background?
  **Task:** What exactly needs to be done?
  **Details:** Any specific technical details, URLs, constraints, or requirements mentioned.

- Example: If user says "move the aggregator latency to railway", the description should be:
  "**Context:** The aggregator latency monitoring needs to be migrated to a new infrastructure.
   **Task:** Move the aggregator latency service/monitoring from current infrastructure to Railway platform.
   **Details:** This involves setting up the service on Railway and ensuring latency tracking continues to work properly."

- If the message includes chat history, summarize ALL relevant context from the conversation
- Include any technical terms, service names, or specifics mentioned
- If something is unclear, mention what might need clarification

=== ASSIGNEE MATCHING (CRITICAL) ===

- ALWAYS return the exact "linearName" from the list above for assigneeName
- Use FUZZY MATCHING: if user writes something similar to an alias, match it:
  - "floflo", "flo", "flouf", "flou" → assigneeName: "florent"
  - "cycy", "cyr", "cyri" → assigneeName: "cyril"  
  - "sandy", "sand", "sanj" → assigneeName: "sanjay"
  - "morg", "morgs" → assigneeName: "morgan"
  - "sach", "del", "delox" → assigneeName: "sachadelox"
  - "aure", "aurel" → assigneeName: "aurelien"
  - "yass", "krab" → assigneeName: "yassine"
  - "pet", "peter", "pan" → assigneeName: "peter"
- If a Telegram username is mentioned (@xxx), find the matching linearName
- NEVER return the telegram username or email as assigneeName, ONLY the linearName

=== OTHER RULES ===

- For "edit": 
  - If user specifies what to edit (e.g., "edit the title to X"), set editField and newValue
  - If user just says "edit this ticket" without specifying, set editField to "menu"
- For "cancel", "delete": identify the ticket from context or message
- For "assign": ONLY use this action if a specific ticket identifier (like MOB-1234) is mentioned. Otherwise use "create".
- For "status": identify the ticket AND the new status
- If the user says "this ticket", "ce ticket", "le ticket", look at recent tickets context
- If you can't determine the ticket, set ticketIdentifier to the most recent one from context
- If the message is unclear, set confidence to 0

=== EXAMPLES ===
User: "assign me Sacha a ticket to clean up the docs"
→ action: "create", title: "Clean up documentation", assigneeName: "sachadelox", ticketIdentifier: null

User: "can you assign me a ticket to fix the login bug"  
→ action: "create", title: "Fix login bug", assigneeName: (the person speaking), ticketIdentifier: null

User: "can you assign a ticket to @Flouflof on adding plume chain"
→ action: "create", title: "Add Plume chain support", assigneeName: "florent", ticketIdentifier: null

User: "assign a ticket to Sandy for updating the docs"
→ action: "create", title: "Update documentation", assigneeName: "sanjay", ticketIdentifier: null

User: "assign MOB-1234 to Cyril"
→ action: "assign", ticketIdentifier: "MOB-1234", assigneeName: "cyril"

User: "create a ticket for Sandy to update the API"
→ action: "create", title: "Update the API", assigneeName: "sanjay", ticketIdentifier: null`;

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

      const parsed = JSON.parse(content) as ParsedCommand;
      
      // Validate and match assignee if present
      if (parsed.assigneeName) {
        const matchedUser = this.findUserByName(parsed.assigneeName);
        if (matchedUser) {
          parsed.assigneeName = matchedUser.name;
        }
      }

      return parsed;
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.error('Failed to parse command with AI:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
      return null;
    }
  }
}

