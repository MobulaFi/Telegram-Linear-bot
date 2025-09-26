# Linear Tracker Bot

A Telegram bot for seamless ticket management in Linear. Enables creating tickets directly from Telegram, tracking progress across all stages—Todo, In Progress, Pipeline, Review, Deploy, QA, Done—and sending real-time updates with progress bars and comments. Designed for teams seeking fast, interactive workflow updates without leaving chat.

---

## Features

- **Ticket creation:** `/ticket <title> | <description>`  
- **Real-time status updates:** Updates ticket progress in Telegram with rich formatting and progress bars.  
- **Comment tracking:** Maintains comments per ticket.  
- **Access control:** Only authorized users can create tickets.  
- **Reliable storage:** Uses Redis for state persistence.  
- **Linear API integration:** Fully compatible with Linear GraphQL API.  

---

## Prerequisites

- Node.js v20+  
- npm or yarn  
- Redis server  
- Telegram Bot Token  
- Linear API credentials (GraphQL endpoint, API key, team ID)

---

## Environment Variables

Create a `.env` file in the project root:

```env
PORT=4000
TELEGRAM_BOT_TOKEN=<your_telegram_bot_token>
LINEAR_API_KEY=<your_linear_api_key>
LINEAR_API_URL=https://api.linear.app/graphql
LINEAR_TEAM_ID=<your_linear_team_id>
REDIS_PRIMARY_URL=redis://localhost:6379
