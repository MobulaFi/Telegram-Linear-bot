import { z } from 'zod';

const LinearTrackerBotConfig = z.object({
  TELEGRAM_ROOM_BOT_TOKEN: z.string(),
  LINEAR_API_KEY: z.string(),
  LINEAR_TEAM_ID: z.string(),
  LINEAR_WEBHOOK: z.string(),
  LINEAR_SIGNING_SECRETS: z.string(),
  LINEAR_API_URL: z.string().default('https://api.linear.app/graphql'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TELEGRAM_ALLOWED_USERNAMES: z.string().default('Sandy0209,NBMSacha,NBMXyeu,sol_knowz'),
  IS_HAWK: z
    .string()
    .optional()
    .transform((val) => (val?.toLowerCase() === 'true'))
    .default(() => false),
});
type LinearTrackerBotConfig = z.infer<typeof LinearTrackerBotConfig>;

export default LinearTrackerBotConfig;
