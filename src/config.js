import 'dotenv/config';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseApiKeys(raw) {
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEYS must contain at least one valid API key.');
  }
  return Object.freeze(keys);
}

const discordToken = requireEnv('DISCORD_TOKEN');
const clientId = requireEnv('CLIENT_ID');
const ownerUserId = requireEnv('OWNER_USER_ID');
const geminiApiKeys = parseApiKeys(requireEnv('GEMINI_API_KEYS'));
const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-live';

export const config = Object.freeze({
  discordToken,
  clientId,
  ownerUserId,
  geminiApiKeys,
  geminiModel,
});
