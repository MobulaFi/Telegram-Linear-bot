# Linear Tracker Bot

A Telegram bot for seamless ticket management in Linear. Enables creating tickets directly from Telegram, tracking progress across all stages—Todo, In Progress, Pipeline, Review, Deploy, QA, Done—and sending real-time updates with progress bars and comments. Designed for teams seeking fast, interactive workflow updates without leaving chat.

---

## Features

- **Ticket creation:** `/ticket <title> | <description>`  
- **Natural language commands:** Mention the bot and describe what you need
- **Image support:** Send screenshots or photos with your request, the AI analyzes them and includes details in the ticket
- **Real-time status updates:** Updates ticket progress in Telegram with rich formatting and progress bars
- **Comment tracking:** Maintains comments per ticket
- **Access control:** Only authorized users can create tickets
- **Reliable storage:** Uses Redis for state persistence
- **Linear API integration:** Fully compatible with Linear GraphQL API

---

## Prerequisites

- Node.js v20+  
- npm or yarn  
- Redis server  
- Telegram Bot Token  
- Linear API credentials (GraphQL endpoint, API key, team ID)
- OpenAI API key

---

## Environment Variables

Create a `.env` file in the project root:

```env
PORT=4000
TELEGRAM_BOT_TOKEN=<your_telegram_bot_token>
TELEGRAM_ALLOWED_USERNAMES=user1,user2,user3
LINEAR_API_KEY=<your_linear_api_key>
LINEAR_API_URL=https://api.linear.app/graphql
LINEAR_TEAM_ID=<your_linear_team_id>
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=<your_openai_api_key>
```

---

## Usage

### Commands

```
/ticket <title> | <description>  - Create a ticket
/help                            - Show help
```

### Natural Language

Mention the bot to use natural language:

```
@bot create a ticket for John to fix the login bug
@bot assign MOB-1234 to Alice
@bot set MOB-567 to In Progress
@bot edit MOB-890
@bot cancel MOB-123
```

### With Images

Send a photo with a caption mentioning the bot. The AI will analyze the image and include relevant details in the ticket description.

```
[Photo attached]
@bot create a ticket for the bug shown in this screenshot
```

The bot supports:
- Screenshots of bugs or errors
- UI mockups or designs
- Any image relevant to the ticket context

---

## Running

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## Docker

```bash
docker build -t linear-telegram-bot .
docker run -d --env-file .env -p 4000:4000 linear-telegram-bot
```
