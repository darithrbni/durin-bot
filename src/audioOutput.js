import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { config } from './config.js';
import { convert } from './rvcConverter.js';

export class AudioOutput {
  constructor(connection) {
    this.connection = connection;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.player.on('error', (err) => {
      console.error('[AudioOutput] AudioPlayer error:', err.message);
    });

    this.connection.subscribe(this.player);

    this.passThrough = null;
    this.ffmpeg = null;
    this.pendingChunks = [];
    this.isConverting = false;
    this.turnGeneration = 0;
    this.destroyed = false;
  }

  _spawnFfmpegPipeline(inputArgs) {
    this._teardownPipeline();

    this.passThrough = new PassThrough();
    this.passThrough.on('error', (err) => {
      if (!this.destroyed && err.code !== 'ERR_STREAM_DESTROYED') {
        console.error('[AudioOutput] PassThrough error:', err.message);
      }
    });

    const isWavInput = inputArgs[inputArgs.indexOf('-f') + 1] === 'wav';

    this.ffmpeg = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        ...inputArgs,
        '-i', 'pipe:0',
        ...(isWavInput ? ['-af', 'silenceremove=stop_periods=-1:stop_duration=0.25:stop_threshold=-45dB'] : []),
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.ffmpeg.on('error', (err) => {
      if (!this.destroyed) {
        console.error('[AudioOutput] FFmpeg error:', err.message);
      }
    });
    this.ffmpeg.stdin.on('error', (err) => {
      if (!this.destroyed && err.code !== 'EPIPE') {
        console.error('[AudioOutput] FFmpeg stdin error:', err.message);
      }
    });
    this.ffmpeg.stdout.on('error', (err) => {
      if (!this.destroyed) {
        console.error('[AudioOutput] FFmpeg stdout error:', err.message);
      }
    });
    this.ffmpeg.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg && !this.destroyed) {
        console.warn(`[AudioOutput][FFmpeg] ${msg}`);
      }
    });

    this.passThrough.pipe(this.ffmpeg.stdin);

    const resource = createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });

    this.player.play(resource);
  }

  _ensureStreamPipeline() {
    if (this.destroyed) return;
    if (this.passThrough && this.ffmpeg && !this.passThrough.destroyed && !this.passThrough.writableEnded) {
      return;
    }

    this._spawnFfmpegPipeline(['-f', 's16le', '-ar', '24000', '-ac', '1']);
  }

  _playWavBuffer(wavBuffer) {
    if (this.destroyed || !wavBuffer || wavBuffer.length === 0) return;
    this._spawnFfmpegPipeline(['-f', 'wav']);
    if (this.passThrough && !this.passThrough.destroyed) {
      this.passThrough.write(wavBuffer);
      this.passThrough.end();
    }
  }

  enqueueAudio(pcm24kBuffer) {
    if (this.destroyed || !pcm24kBuffer || pcm24kBuffer.length === 0) return;

    if (config.rvcEnabled) {
      this.pendingChunks.push(pcm24kBuffer);
      return;
    }

    this._ensureStreamPipeline();
    if (this.passThrough && !this.passThrough.destroyed) {
      this.passThrough.write(pcm24kBuffer);
    }
  }

  async endTurn() {
    if (this.destroyed) return;

    if (config.rvcEnabled) {
      if (this.pendingChunks.length === 0) return;

      const pcmBuffer = Buffer.concat(this.pendingChunks);
      this.pendingChunks = [];
      this.isConverting = true;
      const generation = this.turnGeneration;
      const conversionStartedAt = Date.now();

      try {
        const wavBuffer = await convert(pcmBuffer);
        if (this.destroyed || generation !== this.turnGeneration) return;
        console.log(`[AudioOutput] RVC conversion finished in ${Date.now() - conversionStartedAt}ms, playing Durin's voice...`);
        this._playWavBuffer(wavBuffer);
      } catch (err) {
        if (!this.destroyed) {
          console.error('[AudioOutput] RVC turn playback error:', err.message);
        }
      } finally {
        if (generation === this.turnGeneration) {
          this.isConverting = false;
        }
      }
      return;
    }

    if (!this.passThrough || this.passThrough.destroyed || this.passThrough.writableEnded) return;
    try {
      this.passThrough.end();
    } catch {
      // Ignore cleanup errors
    }
  }

  _teardownPipeline() {
    if (this.passThrough) {
      try {
        this.passThrough.unpipe();
        this.passThrough.destroy();
      } catch {
        // Ignore cleanup errors
      }
      this.passThrough = null;
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
  }

  stop() {
    if (this.destroyed) return;
    this.turnGeneration++;
    this.pendingChunks = [];
    this.isConverting = false;
    this.player.stop(true);
    this._teardownPipeline();
  }

  interrupt() {
    this.stop();
  }

  playLocalFile(filePath) {
    if (this.destroyed) return Promise.resolve();
    this.interrupt();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onPlayerError);
        resolve();
      };

      const onIdle = () => finish();
      const onPlayerError = () => finish();

      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onPlayerError);

      const fileFfmpeg = spawn(
        ffmpegPath,
        [
          '-loglevel', 'error',
          '-i', filePath,
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      this.ffmpeg = fileFfmpeg;

      fileFfmpeg.on('error', (err) => {
        console.error('[AudioOutput] Local file FFmpeg error:', err.message);
        finish();
      });
      fileFfmpeg.stdout.on('error', () => finish());
      fileFfmpeg.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.warn(`[AudioOutput][LocalFFmpeg] ${msg}`);
      });

      const resource = createAudioResource(fileFfmpeg.stdout, {
        inputType: StreamType.Raw,
      });

      this.player.play(resource);
    });
  }

  isPlaying() {
    return (
      this.pendingChunks.length > 0 ||
      this.isConverting ||
      this.player.state.status !== AudioPlayerStatus.Idle
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.turnGeneration++;
    this.pendingChunks = [];
    this.isConverting = false;
    try {
      this.player.stop(true);
      this.player.removeAllListeners();
    } catch {
      // Ignore cleanup errors
    }
    this._teardownPipeline();
  }
}
