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

function parseBoolean(raw, defaultValue) {
  const val = raw?.trim().toLowerCase();
  if (!val) return defaultValue;
  if (val === 'true' || val === '1' || val === 'yes') return true;
  if (val === 'false' || val === '0' || val === 'no') return false;
  return defaultValue;
}

function parseNumber(raw, defaultValue) {
  const val = raw?.trim();
  if (!val) return defaultValue;
  const num = Number(val);
  return Number.isFinite(num) ? num : defaultValue;
}

const discordToken = requireEnv('DISCORD_TOKEN');
const clientId = requireEnv('CLIENT_ID');
const ownerUserId = requireEnv('OWNER_USER_ID');
const geminiApiKeys = parseApiKeys(requireEnv('GEMINI_API_KEYS'));
const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-live';

const rvcEnabled = parseBoolean(process.env.RVC_ENABLED, true);
const rvcApiUrl = (process.env.RVC_API_URL?.trim() || 'http://127.0.0.1:6969').replace(/\/+$/, '');
const rvcModelPath = process.env.RVC_MODEL_PATH?.trim() || 'logs/durin-en/durin-en_300e_11100s.pth';
const rvcIndexPath = process.env.RVC_INDEX_PATH?.trim() || 'logs/durin-en/durin-en.index';
const rvcPitch = parseNumber(process.env.RVC_PITCH, 5);
const rvcIndexRate = parseNumber(process.env.RVC_INDEX_RATE, 0.75);

export const config = Object.freeze({
  discordToken,
  clientId,
  ownerUserId,
  geminiApiKeys,
  geminiModel,
  rvcEnabled,
  rvcApiUrl,
  rvcModelPath,
  rvcIndexPath,
  rvcPitch,
  rvcIndexRate,
});
