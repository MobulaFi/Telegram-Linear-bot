// Mapping between Telegram usernames and Linear users
// Format: telegramUsername (without @) -> { linearName, linearEmail }

export interface UserMapping {
  telegramUsername: string;
  linearName: string;
  linearEmail: string;
  aliases: string[]; // Alternative names that can be used to refer to this person
}

export const USER_MAPPINGS: UserMapping[] = [
  {
    telegramUsername: 'Flouflof',
    linearName: 'florent',
    linearEmail: 'florent@mobula.io',
    aliases: ['florent', 'flo', 'floflo', 'flouflof', 'floflouf', 'flou', 'flouf'],
  },
  {
    telegramUsername: 'cocyril',
    linearName: 'cyril',
    linearEmail: 'cyril@mobula.io',
    aliases: ['cyril', 'coco'],
  },
  {
    telegramUsername: 'sacha_xyz',
    linearName: 'sachadelox',
    linearEmail: 'goat@mobula.io',
    aliases: ['sachadelox', 'delox', 'sacha_xyz', 'goat'],
  },
  {
    telegramUsername: 'Mrg77i',
    linearName: 'morgan',
    linearEmail: 'morgan@mobula.io',
    aliases: ['morgan', 'mrg'],
  },
  {
    telegramUsername: 'NBMXyeu',
    linearName: 'teo',
    linearEmail: 'teo@mobula.io',
    aliases: ['teo', 'téo', 'xyeu'],
  },
  {
    telegramUsername: 'NBMSacha',
    linearName: 'sacha',
    linearEmail: 'sacha@mobula.io',
    aliases: ['sacha', 'nbmsacha'],
  },
  {
    telegramUsername: 'Sandy0209',
    linearName: 'sanjay',
    linearEmail: 'sanjay@mobula.io',
    aliases: ['sandy', 'sanjay', 'sand'],
  },
  {
    telegramUsername: 'thecryptogange',
    linearName: 'aurelien',
    linearEmail: 'aurelien@mobula.io',
    aliases: ['aurelien', 'aure'],
  },
  {
    telegramUsername: 'KrabsP',
    linearName: 'yassine',
    linearEmail: 'yassine@mobula.io',
    aliases: ['yassine', 'krabs'],
  },
  {
    telegramUsername: 'peterpan0x',
    linearName: 'peter',
    linearEmail: 'pantaovay@gmail.com',
    aliases: ['peter', 'peterpan', 'pan'],
  },
  {
    telegramUsername: 'Doven1995',
    linearName: 'doven',
    linearEmail: 'huangdongxc@gmail.com',
    aliases: ['doven'],
  },
  {
    telegramUsername: 'duwuxie1001',
    linearName: 'jaxon',
    linearEmail: 'duwenjie1001@gmail.com',
    aliases: ['jaxon', 'duwenjie'],
  },
];

// Helper function to find Linear user by any identifier (telegram username, name, alias)
export function findLinearUserByIdentifier(identifier: string): UserMapping | null {
  const normalizedId = identifier.toLowerCase().replace('@', '');
  
  return USER_MAPPINGS.find((user) => {
    return (
      user.telegramUsername.toLowerCase() === normalizedId ||
      user.linearName.toLowerCase() === normalizedId ||
      user.linearEmail.toLowerCase() === normalizedId ||
      user.aliases.some((alias) => alias.toLowerCase() === normalizedId)
    );
  }) ?? null;
}

// Get all aliases for AI prompt
export function getAllUserAliases(): string[] {
  const aliases: string[] = [];
  for (const user of USER_MAPPINGS) {
    aliases.push(user.telegramUsername);
    aliases.push(user.linearName);
    aliases.push(...user.aliases);
  }
  return [...new Set(aliases)];
}

