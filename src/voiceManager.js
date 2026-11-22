import path from 'node:path';
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { config } from './config.js';
import { keyPool } from './keyPool.js';
import { GeminiLiveClient } from './geminiLive.js';
import { AudioInput } from './audioInput.js';
import { AudioOutput } from './audioOutput.js';

const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const QUOTA_LIMIT_AUDIO = path.resolve(process.cwd(), 'assets', 'quota_limit.wav');

export class VoiceManager {
  constructor() {
    this.connection = null;
    this.geminiLive = null;
    this.audioInput = null;
    this.audioOutput = null;
    this.isLeaving = false;
  }

  isConnected() {
    return this.connection !== null;
  }

  async joinChannel(voiceChannel) {
    if (this.connection) {
      await this.leaveChannel();
    }

    this.isLeaving = false;

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.connection = connection;

    connection.on('error', (err) => {
      console.error('[VoiceManager] VoiceConnection error:', err.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.isLeaving) return;
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await this.leaveChannel();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      await this.leaveChannel();
      throw new Error(`Failed to reach VoiceConnection Ready state: ${err.message}`);
    }

    // UDP Keep-Alive Fix: inject 5 frames of Opus silence so Discord opens inbound UDP audio
    for (let i = 0; i < 5; i++) {
      connection.playOpusPacket(OPUS_SILENCE_FRAME);
    }

    this.audioOutput = new AudioOutput(connection);

    if (!keyPool.hasAvailableKeys()) {
      console.warn('[VoiceManager] No available Gemini API keys. Playing quota limit audio.');
      await this.audioOutput.playLocalFile(QUOTA_LIMIT_AUDIO);
      await this.leaveChannel();
      return;
    }

    this.geminiLive = new GeminiLiveClient();
    this.audioInput = new AudioInput(connection, config.ownerUserId);

    this.audioInput.on('speechStart', () => {
      if (this.audioOutput?.isPlaying()) {
        this.audioOutput.interrupt();
        this.geminiLive?.sendInterrupt();
      }
    });

    this.audioInput.on('audioFrame', (pcm16kBuffer) => {
      this.geminiLive?.sendAudioChunk(pcm16kBuffer.toString('base64'));
    });

    this.audioInput.on('error', (err) => {
      console.error('[VoiceManager] AudioInput error:', err.message);
    });

    this.geminiLive.on('audioData', (pcm24kBuffer) => {
      this.audioOutput?.enqueueAudio(pcm24kBuffer);
    });

    this.geminiLive.on('error', (err) => {
      console.error('[VoiceManager] GeminiLive error:', err.message);
    });

    this.geminiLive.on('allKeysExhausted', async () => {
      console.warn('[VoiceManager] All Gemini API keys exhausted. Playing fallback audio and leaving.');
      if (this.audioOutput && !this.isLeaving) {
        this.audioOutput.interrupt();
        await this.audioOutput.playLocalFile(QUOTA_LIMIT_AUDIO);
      }
      await this.leaveChannel();
    });

    await this.geminiLive.connect();
    await this.audioInput.start();
    console.log(`[VoiceManager] Joined voice channel "${voiceChannel.name}" and started session.`);
  }

  async leaveChannel() {
    if (this.isLeaving) return;
    this.isLeaving = true;

    if (this.audioInput) {
      this.audioInput.destroy();
      this.audioInput = null;
    }

    if (this.audioOutput) {
      this.audioOutput.destroy();
      this.audioOutput = null;
    }

    if (this.geminiLive) {
      this.geminiLive.disconnect();
      this.geminiLive.removeAllListeners();
      this.geminiLive = null;
    }

    if (this.connection) {
      try {
        this.connection.removeAllListeners();
        this.connection.destroy();
      } catch {
        // Ignore cleanup errors
      }
      this.connection = null;
    }

    this.isLeaving = false;
    console.log('[VoiceManager] Left voice channel and cleaned up session resources.');
  }
}

export const voiceManager = new VoiceManager();
