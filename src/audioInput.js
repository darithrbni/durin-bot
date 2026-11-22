import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import ffmpegPath from 'ffmpeg-static';
import { NonRealTimeVAD, Message } from '@ricky0123/vad-node';

const FRAME_SAMPLES = 1536; // 96ms at 16kHz (Silero VAD optimal frame size)
const BYTES_PER_SAMPLE = 2; // 16-bit signed LE
const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE; // 3072 bytes
const CONFIRM_SPEECH_FRAMES = 2; // ~192ms-200ms confirmation before barge-in

export class AudioInput extends EventEmitter {
  constructor(connection, ownerUserId) {
    super();
    this.connection = connection;
    this.ownerUserId = ownerUserId;

    this.opusStream = null;
    this.opusDecoder = null;
    this.ffmpeg = null;
    this.vad = null;

    this.pcmBuffer = Buffer.alloc(0);
    this.vadQueue = Promise.resolve();

    this.inVadSpeech = false;
    this.speechConfirmed = false;
    this.pendingFrames = [];
    this.destroyed = false;
    this.speakingHandler = null;
  }

  async start() {
    if (this.destroyed) return;

    this.vad = await NonRealTimeVAD.new({
      positiveSpeechThreshold: 0.55,
      negativeSpeechThreshold: 0.40,
      redemptionFrames: 6, // ~576ms silence before speechEnd
      minSpeechFrames: 2,
      preSpeechPadFrames: 1,
      frameSamples: FRAME_SAMPLES,
    });
    this.vad.frameProcessor.resume();

    this.ffmpeg = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.ffmpeg.on('error', (err) => {
      if (!this.destroyed) this.emit('error', err);
    });
    this.ffmpeg.stdin.on('error', (err) => {
      if (!this.destroyed && err.code !== 'EPIPE') this.emit('error', err);
    });
    this.ffmpeg.stdout.on('error', (err) => {
      if (!this.destroyed) this.emit('error', err);
    });
    this.ffmpeg.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg && !this.destroyed) {
        console.warn(`[AudioInput][FFmpeg] ${msg}`);
      }
    });

    this.opusDecoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    this.opusDecoder.on('error', (err) => {
      if (!this.destroyed) this.emit('error', err);
    });

    this.speakingHandler = (userId) => {
      if (userId !== this.ownerUserId || this.destroyed || this.opusStream) return;
      this._subscribeToOwner();
    };
    this.connection.receiver.speaking.on('start', this.speakingHandler);

    this.ffmpeg.stdout.on('data', (chunk) => {
      if (this.destroyed) return;
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);

      while (this.pcmBuffer.length >= FRAME_BYTES) {
        const frameBuf = this.pcmBuffer.subarray(0, FRAME_BYTES);
        this.pcmBuffer = this.pcmBuffer.subarray(FRAME_BYTES);
        const frameCopy = Buffer.from(frameBuf);

        this.vadQueue = this.vadQueue
          .then(() => this._processVadFrame(frameCopy))
          .catch((err) => {
            if (!this.destroyed) this.emit('error', err);
          });
      }
    });
  }

  _subscribeToOwner() {
    if (this.destroyed || this.opusStream) return;

    this.opusStream = this.connection.receiver.subscribe(this.ownerUserId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });
    this.opusStream.on('error', (err) => {
      if (!this.destroyed) this.emit('error', err);
    });

    this.opusStream.pipe(this.opusDecoder).pipe(this.ffmpeg.stdin);
    console.log('[AudioInput] Subscribed to owner speech stream');
  }

  async _processVadFrame(frameBuffer) {
    if (this.destroyed || !this.vad?.frameProcessor) return;

    const float32 = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      float32[i] = frameBuffer.readInt16LE(i * 2) / 32768.0;
    }

    const result = await this.vad.frameProcessor.process(float32);

    if (result.msg === Message.SpeechStart) {
      console.log('[AudioInput] VAD speechStart');
      this.inVadSpeech = true;
      this.speechConfirmed = false;
      this.pendingFrames = [frameBuffer];
      return;
    }

    if (result.msg === Message.VADMisfire) {
      this.inVadSpeech = false;
      this.speechConfirmed = false;
      this.pendingFrames = [];
      return;
    }

    if (result.msg === Message.SpeechEnd) {
      console.log('[AudioInput] VAD speechEnd');
      if (this.speechConfirmed) {
        this.emit('audioFrame', frameBuffer);
        this.emit('speechEnd');
      }
      this.inVadSpeech = false;
      this.speechConfirmed = false;
      this.pendingFrames = [];
      return;
    }

    if (this.inVadSpeech) {
      if (!this.speechConfirmed) {
        this.pendingFrames.push(frameBuffer);
        if (this.pendingFrames.length >= CONFIRM_SPEECH_FRAMES) {
          this.speechConfirmed = true;
          this.emit('speechStart');
          for (const bufferedFrame of this.pendingFrames) {
            this.emit('audioFrame', bufferedFrame);
          }
          this.pendingFrames = [];
        }
      } else {
        this.emit('audioFrame', frameBuffer);
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.speakingHandler) {
      try {
        this.connection.receiver.speaking.off('start', this.speakingHandler);
      } catch {
        // Ignore cleanup errors
      }
      this.speakingHandler = null;
    }

    this.pcmBuffer = Buffer.alloc(0);
    this.pendingFrames = [];
    this.inVadSpeech = false;
    this.speechConfirmed = false;

    if (this.opusStream) {
      try {
        this.opusStream.unpipe();
        this.opusStream.destroy();
      } catch {
        // Ignore cleanup errors
      }
      this.opusStream = null;
    }

    if (this.opusDecoder) {
      try {
        this.opusDecoder.unpipe();
        this.opusDecoder.destroy();
      } catch {
        // Ignore cleanup errors
      }
      this.opusDecoder = null;
    }

    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdin?.destroy();
        this.ffmpeg.stdout?.destroy();
        this.ffmpeg.stderr?.destroy();
        this.ffmpeg.kill('SIGKILL');
      } catch {
        // Ignore cleanup errors
      }
      this.ffmpeg = null;
    }

    this.removeAllListeners();
  }
}
