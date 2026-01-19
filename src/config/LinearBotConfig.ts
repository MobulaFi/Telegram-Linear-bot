import { z } from 'zod';

const LinearTrackerBotConfig = z.object({
  TELEGRAM_BOT_TOKEN: z.string(),
  LINEAR_API_KEY: z.string(),
  LINEAR_TEAM_ID: z.string(),
  LINEAR_WEBHOOK: z.string().optional().default(''),
  LINEAR_SIGNING_SECRETS: z.string().optional().default(''),
  LINEAR_API_URL: z.string().default('https://api.linear.app/graphql'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TELEGRAM_ALLOWED_USERNAMES: z.string().default('Sandy0209,NBMSacha,NBMXyeu,sol_knowz'),
  TELEGRAM_ADMIN_USERNAME: z.string().default('Flouflof'),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional().default(''),
  IS_HAWK: z
    .string()
    .optional()
    .transform((val) => (val?.toLowerCase() === 'true'))
    .default(() => false),
  OPENAI_API_KEY: z.string(),
});
type LinearTrackerBotConfig = z.infer<typeof LinearTrackerBotConfig>;

export default LinearTrackerBotConfig;
