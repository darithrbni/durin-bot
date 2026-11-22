import { config } from './config.js';

export class KeyPool {
  constructor(keys) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('KeyPool requires a non-empty array of API keys.');
    }
    this.entries = keys.map((key) => ({
      key,
      cooldownUntil: 0,
    }));
  }

  getActiveKey() {
    const now = Date.now();
    const available = this.entries.find((entry) => now >= entry.cooldownUntil);
    return available ? available.key : null;
  }

  markRateLimited(key, durationMs = 65_000) {
    const index = this.entries.findIndex((entry) => entry.key === key);
    if (index === -1) return;

    this.entries[index].cooldownUntil = Date.now() + durationMs;
    const masked = `${key.slice(0, 6)}...${key.slice(-4)}`;
    console.warn(
      `[KeyPool] Key #${index + 1} (${masked}) rate-limited for ${Math.round(durationMs / 1000)}s. Rotating to next available key.`
    );
  }

  hasAvailableKeys() {
    return this.getActiveKey() !== null;
  }
}

export const keyPool = new KeyPool(config.geminiApiKeys);
