import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';
import { config } from './config.js';
import { keyPool } from './keyPool.js';
import { DURIN_SYSTEM_INSTRUCTION, DURIN_VOICE_NAME } from './durinPersona.js';

function isRateLimitMessage(text = '', code) {
  const normalized = String(text).toLowerCase();
  return (
    code === 429 ||
    code === 1013 ||
    normalized.includes('429') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('quota') ||
    normalized.includes('rate limit')
  );
}

export class GeminiLiveClient extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.currentKey = null;
    this.isConnected = false;
    this.intentionallyClosed = false;
    this.isRotating = false;
    this.ignoreCurrentTurnAudio = false;
    this.loggedTurnAudio = false;
    this.greetingSent = false;
  }

  async connect() {
    this.intentionallyClosed = false;
    this.isRotating = false;
    this.loggedTurnAudio = false;
    this.greetingSent = false;

    const apiKey = keyPool.getActiveKey();
    if (!apiKey) {
      this.emit('allKeysExhausted');
      return;
    }

    this.currentKey = apiKey;
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1beta' },
    });

    try {
      this.session = await ai.live.connect({
        model: config.geminiModel,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: DURIN_VOICE_NAME,
              },
            },
          },
          systemInstruction: {
            parts: [{ text: DURIN_SYSTEM_INSTRUCTION }],
          },
        },
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            console.log('[GeminiLive] WebSocket session opened.');
            setTimeout(() => this._sendInitialGreeting(), 0);
          },
          onmessage: (message) => {
            this._handleServerMessage(message);
          },
          onerror: (errEvent) => {
            const msg = errEvent?.message || errEvent?.error?.message || 'Unknown WebSocket error';
            if (isRateLimitMessage(msg)) {
              this._handleRateLimit(msg);
              return;
            }
            this.emit('error', new Error(`[GeminiLive] WebSocket error: ${msg}`));
          },
          onclose: (closeEvent) => {
            this.isConnected = false;
            const reason = closeEvent?.reason || '';
            const code = closeEvent?.code;

            if (this.intentionallyClosed) {
              return;
            }

            if (isRateLimitMessage(reason, code)) {
              this._handleRateLimit(reason || `Close code ${code}`);
              return;
            }

            console.warn(`[GeminiLive] WebSocket closed unexpectedly (code=${code}, reason=${reason}).`);
          },
        },
      });
      this._sendInitialGreeting();
    } catch (err) {
      const msg = err?.message || String(err);
      if (isRateLimitMessage(msg, err?.status)) {
        await this._handleRateLimit(msg);
        return;
      }
      this.emit('error', err instanceof Error ? err : new Error(msg));
    }
  }

  _sendInitialGreeting() {
    if (!this.session || !this.isConnected || this.greetingSent) return;
    this.greetingSent = true;
    try {
      this.session.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [
              {
                text: 'Hello Durin, I just joined the voice channel. Say a brief hello.',
              },
            ],
          },
        ],
        turnComplete: true,
      });
      console.log('[GeminiLive] Sent initial greeting prompt.');
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  _handleServerMessage(message) {
    const serverContent = message?.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.ignoreCurrentTurnAudio = false;
      this.loggedTurnAudio = false;
      return;
    }

    const parts = serverContent.modelTurn?.parts;
    if (Array.isArray(parts) && !this.ignoreCurrentTurnAudio) {
      for (const part of parts) {
        const inlineData = part?.inlineData;
        if (inlineData?.data && (!inlineData.mimeType || inlineData.mimeType.startsWith('audio/'))) {
          const pcmBuffer = Buffer.from(inlineData.data, 'base64');
          if (pcmBuffer.length > 0) {
            if (!this.loggedTurnAudio) {
              console.log(`[GeminiLive] Received audio chunk (${pcmBuffer.length} bytes)`);
              this.loggedTurnAudio = true;
            }
            this.emit('audioData', pcmBuffer);
          }
        }
      }
    }

    if (serverContent.turnComplete) {
      this.ignoreCurrentTurnAudio = false;
      this.loggedTurnAudio = false;
      console.log('[GeminiLive] Turn complete');
      this.emit('turnComplete');
    }
  }

  async _handleRateLimit(reason) {
    if (this.isRotating || this.intentionallyClosed) return;
    this.isRotating = true;
    this.isConnected = false;

    if (this.currentKey) {
      keyPool.markRateLimited(this.currentKey);
    }

    this._closeSocketOnly();
    this.emit('rateLimit', reason);

    if (keyPool.hasAvailableKeys()) {
      await this.connect();
    } else {
      this.emit('allKeysExhausted');
    }
  }

  sendAudioChunk(pcm16kBase64) {
    if (!this.session || !this.isConnected || this.intentionallyClosed) return;
    try {
      this.ignoreCurrentTurnAudio = false;
      this.session.sendRealtimeInput({
        audio: {
          data: pcm16kBase64,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  sendInterrupt() {
    this.ignoreCurrentTurnAudio = true;
    if (!this.session || !this.isConnected || this.intentionallyClosed) return;
    try {
      this.session.sendRealtimeInput({
        audioStreamEnd: true,
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  _closeSocketOnly() {
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // Ignore close errors on already-closed sockets
      }
      this.session = null;
    }
    this.isConnected = false;
  }

  disconnect() {
    this.intentionallyClosed = true;
    this.ignoreCurrentTurnAudio = false;
    this._closeSocketOnly();
    this.currentKey = null;
  }
}
