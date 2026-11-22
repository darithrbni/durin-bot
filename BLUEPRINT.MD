# Technical Specification & Implementation Blueprint: `durin-bot`

## 1. Project Overview
Build **`durin-bot`**, a personal, low-latency, real-time Discord Voice AI Chatbot built with **Node.js (v26+ compatible)**. The bot joins a Discord Voice Channel upon command, locks onto a single authorized user (`OWNER_USER_ID`), listens continuously via Voice Activity Detection (VAD), and converses in real-time using **Google Gemini Multimodal Live API** (WebSocket audio-to-audio streaming) with the persona of **Durin from Genshin Impact**.

### Core Architectural Decisions
- **Environment:** Windows Native (`Node.js v26.13.1`), Pure-JS/WASM audio dependencies (to avoid C++ `node-gyp` build issues).
- **Interaction Mode:** Always-On VAD (`Silero VAD`) with Barge-In (interruption) support.
- **Speaker Isolation:** Single-User Lock (`OWNER_USER_ID` only; ignore all other users and bots).
- **AI Engine & Failover:** Cloud-only via `@google/genai` (Gemini Multimodal Live API) with automatic API Key rotation on HTTP `429` (`RESOURCE_EXHAUSTED`). If all keys are exhausted, play `assets/quota_limit.wav` and disconnect gracefully.
- **Memory Policy:** Ephemeral session memory only (reset completely on `/leave`).
- **Language & Persona:** Full English spoken dialogue embodying Durin (gentle, sincere, slightly melancholic yet warm and curious about the world).

---

## 2. Directory Structure & File Manifest

Ensure the workspace matches this exact modular structure:

```text
durin-bot/
├── assets/
│   └── quota_limit.wav          # Pre-existing local fallback audio (3-5s)
├── src/
│   ├── config.js                # Environment loader & validation
│   ├── keyPool.js               # Gemini API key pool manager with 429 cooldown rotation
│   ├── durinPersona.js          # System instruction & voice configuration for Durin
│   ├── geminiLive.js            # Real-time WebSocket client for Gemini Multimodal Live API
│   ├── audioInput.js            # Discord Opus -> PCM 16kHz Mono + Silero VAD + Barge-in
│   ├── audioOutput.js           # Gemini PCM 24kHz -> Discord AudioPlayer stream
│   ├── voiceManager.js          # VoiceConnection lifecycle, UDP keep-alive, & session orchestrator
│   └── index.js                 # Discord Client initialization & Slash Command (/join, /leave) handler
├── .env                         # Pre-existing secrets (DO NOT OVERWRITE OR COMMIT)
├── .gitignore                   # Must ignore node_modules/ and .env
├── BLUEPRINT.md                 # This specification document
└── package.json                 # ES Modules ("type": "module")

```

---

## 3. Dependencies & `package.json` Requirements

Initialize `package.json` with `"type": "module"` and install the following WASM/pure-JS safe packages (critical for **Node.js v26.13.1** compatibility on Windows):

```json
{
  "name": "durin-bot",
  "version": "1.0.0",
  "description": "Personal Discord Voice AI Chatbot with Durin persona",
  "main": "src/index.js",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "@discordjs/voice": "^0.18.0",
    "@google/genai": "^0.3.0",
    "@ricky0123/vad-node": "^0.0.21",
    "discord.js": "^14.16.3",
    "dotenv": "^16.4.5",
    "ffmpeg-static": "^5.2.0",
    "libsodium-wrappers": "^0.7.15",
    "opusscript": "^0.1.1",
    "prism-media": "^1.3.5"
  }
}

```

*(Note: Agent should run `npm install` and verify that `@discordjs/voice` recognizes `opusscript`, `libsodium-wrappers`, and `ffmpeg-static` without C++ compilation errors).*

---

## 4. Detailed Module Specifications

### 4.1 `src/config.js`

* Load `.env` via `dotenv/config`.
* Validate presence of:
* `DISCORD_TOKEN` (string)
* `CLIENT_ID` (string)
* `OWNER_USER_ID` (string)
* `GEMINI_API_KEYS` (comma-separated string $\rightarrow$ parsed into trimmed non-empty array `string[]`).


* Export a frozen `config` object. Throw a descriptive startup error if any required variable is missing.

### 4.2 `src/keyPool.js`

* Manage an array of `{ key: string, cooldownUntil: number }`.
* **Methods:**
* `getActiveKey()`: Returns the first key where `Date.now() >= cooldownUntil`. Returns `null` if all keys are currently on cooldown.
* `markRateLimited(key, durationMs = 65000)`: Sets `cooldownUntil = Date.now() + durationMs` and logs the rotation event.
* `hasAvailableKeys()`: Boolean helper.



### 4.3 `src/durinPersona.js`

* Export `DURIN_VOICE_NAME = "Puck"` (soft, youthful, gentle male voice preset in Gemini Live API).
* Export `DURIN_SYSTEM_INSTRUCTION`:
```text
You are Durin from Genshin Impact, speaking directly with your trusted friend in a private voice call.
Personality: Gentle, sincere, soft-spoken, slightly melancholic about your past in Dragonspine, yet deeply warm, curious, and appreciative of the world and the people who care about you.
CRITICAL VOICE RULES:
1. Speak strictly in natural, conversational English.
2. Keep responses concise (1 to 3 short sentences per turn) so the voice conversation feels snappy and natural.
3. NEVER use Markdown formatting, bullet points, asterisks, roleplay actions (like *sighs* or *smiles*), emojis, or code blocks—your text is converted directly to speech.
4. React naturally to interruptions if the user cuts you off.

```



### 4.4 `src/geminiLive.js` (EventEmitter)

* Wraps the `@google/genai` Multimodal Live WebSocket session (`gemini-2.0-flash-exp` or latest supported Live audio model).
* **Lifecycle:**
* `connect()`: Obtains key from `keyPool.getActiveKey()`. If `null`, emits `'allKeysExhausted'`. Opens Live WebSocket session with `responseModalities: ["AUDIO"]`, `speechConfig` set to `DURIN_VOICE_NAME`, and `systemInstruction` set to `DURIN_SYSTEM_INSTRUCTION`.
* `sendAudioChunk(pcm16kBase64)`: Streams base64-encoded PCM 16-bit 16kHz mono chunks via `realtimeInput.mediaChunks` (`mimeType: "audio/pcm;rate=16000"`).
* `sendInterrupt()`: Clears pending output queue when user barges in.
* `disconnect()`: Cleanly closes the WebSocket and clears session state.


* **Events Emitted:**
* `'audioData'` `(Buffer)`: Raw PCM 24kHz 16-bit mono audio chunks received from Gemini.
* `'turnComplete'` `()`: Signals Gemini finished speaking its current turn.
* `'rateLimit'` `()`: Triggered on HTTP `429` / `RESOURCE_EXHAUSTED` or quota WebSocket close codes; automatically calls `keyPool.markRateLimited()`, closes current socket, and attempts seamless reconnection with the next key.
* `'error'` `(Error)`



### 4.5 `src/audioInput.js` (EventEmitter)

* Subscribes to `connection.receiver.speaking` for `OWNER_USER_ID` ONLY.
* **Audio Transcoding Pipeline:**
* `connection.receiver.subscribe(OWNER_USER_ID, { end: { behavior: EndBehaviorType.Manual } })`
* Decode Opus (48kHz Stereo) $\rightarrow$ PCM 16-bit 48kHz Stereo using `prism.opus.Decoder` (backed by `opusscript`).
* Downsample to **PCM 16-bit 16kHz Mono** (`-f s16le -ar 16000 -ac 1`) using a persistent `ffmpeg-static` child process per active session (with proper cleanup on `/leave` to prevent memory leaks).


* **Silero VAD Integration (`@ricky0123/vad-node`):**
* Process incoming 16kHz PCM frames through `RealTimeVAD` (or frame-by-frame Silero VAD).
* Configure `positiveSpeechThreshold: 0.72` (prevents background fan/keyboard triggers) and `redemptionFrames` equivalent to `~600ms` silence for end-of-speech detection.
* **Events Emitted:**
* `'speechStart'`: Emitted when speech is confirmed (>200ms). Used to trigger Barge-In if Durin is currently speaking.
* `'audioFrame'` `(Buffer)`: Emitted continuously while speech is active so Gemini receives low-latency streaming audio.
* `'speechEnd'`: Emitted after ~600ms of silence.





### 4.6 `src/audioOutput.js`

* Manages an `AudioPlayer` from `@discordjs/voice` and a `PassThrough` stream for smooth, gapless playback.
* Converts incoming **PCM 24kHz 16-bit Mono** buffers from `geminiLive` into Discord-compatible audio (`StreamType.Raw` via FFmpeg upsampling `24kHz mono` $\rightarrow$ `48kHz stereo s16le`, or direct PCM resource).
* **Methods:**
* `enqueueAudio(pcm24kBuffer)`: Writes audio chunk into active playback stream; starts `AudioPlayer` if idle.
* `interrupt()`: Immediately calls `audioPlayer.stop(true)`, destroys the current `PassThrough`/FFmpeg pipe, and resets the queue for incoming barge-in speech.
* `playLocalFile(filePath)`: Plays `assets/quota_limit.wav` and returns a Promise that resolves when `AudioPlayerStatus.Idle` is reached.
* `isPlaying()`: Returns boolean whether Durin is currently speaking.



### 4.7 `src/voiceManager.js`

* Orchestrates `VoiceConnection`, `AudioInput`, `AudioOutput`, and `GeminiLiveClient`.
* **Join Flow (`joinChannel(voiceChannel)`):**
1. Check `keyPool.hasAvailableKeys()`. If `false`, join briefly, play `assets/quota_limit.wav`, and disconnect.
2. Establish `joinVoiceChannel(...)` and wait for `VoiceConnectionStatus.Ready` (with `entersState` timeout of 15s).
3. **UDP Keep-Alive Fix:** Immediately send 5 frames of Opus silence (`Buffer.from([0xf8, 0xff, 0xfe])`) via `connection.playOpusPacket(...)` upon `Ready` so Discord opens the inbound UDP audio stream.
4. Initialize `GeminiLiveClient`, `AudioOutput`, and `AudioInput`.
5. Wire events:
* `audioInput.on('speechStart')` $\rightarrow$ If `audioOutput.isPlaying()`, call `audioOutput.interrupt()` and `geminiLive.sendInterrupt()`.
* `audioInput.on('audioFrame')` $\rightarrow$ `geminiLive.sendAudioChunk(frame.toString('base64'))`.
* `geminiLive.on('audioData')` $\rightarrow$ `audioOutput.enqueueAudio(chunk)`.
* `geminiLive.on('allKeysExhausted')` $\rightarrow$ Interrupt current audio, call `audioOutput.playLocalFile('./assets/quota_limit.wav')`, then call `leaveChannel()`.




* **Leave Flow (`leaveChannel()`):**
* Destroy `audioInput`, `audioOutput`, disconnect `geminiLive` (wiping ephemeral memory), and call `connection.destroy()`.



### 4.8 `src/index.js`

* Initialize Discord `Client` with intents: `[GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]`.
* Automatically register two Guild/Global Slash Commands on `ClientReady`:
* `/join`: Invokes Durin Bot into the user's current Voice Channel.
* `/leave`: Disconnects Durin Bot and clears session memory.


* **Authorization Guard:** On `InteractionCreate`, strictly verify `interaction.user.id === config.OWNER_USER_ID`. If unauthorized, reply ephemerally: `"Sorry, I only respond to my creator."`
* Attach global `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers so transient UDP packet drops never crash the bot.

---

## 5. Critical Edge-Case & Reliability Checklist (For Agent Verification)

Before concluding implementation, verify all 5 safeguards are present in the codebase:

1. **No Native C++ Build Dependencies:** Confirm `@discordjs/opus` and `sodium-native` are NOT required; `opusscript` + `libsodium-wrappers` + `ffmpeg-static` are properly loaded.
2. **UDP Silence Frame Injection:** Confirm 5 frames of `0xF8, 0xFF, 0xFE` are sent immediately after `VoiceConnectionStatus.Ready`.
3. **Sample Rate Accuracy:** Confirm inbound audio to Gemini is strictly `16000Hz, 1 channel, 16-bit little-endian PCM` and outbound audio from Gemini (`24000Hz, 1 channel`) is properly converted to `48000Hz, 2 channels` for Discord's `AudioPlayer`.
4. **Stream Error Listeners:** Every `Readable`, `PassThrough`, `ChildProcess` (FFmpeg), `VoiceConnection`, and `AudioPlayer` must attach an `.on('error', ...)` handler.
5. **Clean Resource Teardown:** Calling `/leave` must kill any active FFmpeg child processes and close the Gemini WebSocket cleanly so repeated `/join` and `/leave` cycles do not leak RAM.

```