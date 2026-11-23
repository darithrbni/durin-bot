import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const RVC_TIMEOUT_MS = 30_000;
const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

let cachedEndpoints = null;
let endpointDiscoveryPromise = null;

function createWavBuffer(pcmBuffer) {
  const data = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.alloc(0);
  const dataSize = data.length;
  const header = Buffer.alloc(44);

  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, data]);
}

async function fetchGradioInfo(signal) {
  const paths = ['/gradio_api/info', '/info'];
  let lastError = null;

  for (const infoPath of paths) {
    try {
      const res = await fetch(`${config.rvcApiUrl}${infoPath}`, { signal });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} from ${infoPath}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('Failed to fetch Gradio API info');
}

function getParameterName(param) {
  return (param?.parameter_name || param?.label || '').toString().toLowerCase();
}

function getParameterLabel(param) {
  return (param?.label || '').toString().toLowerCase();
}

function getComponent(param) {
  return (param?.component || '').toString().toLowerCase();
}

function isFileParameter(param) {
  const type = (param?.type || param?.parameter_type || '').toString().toLowerCase();
  return ['filepath', 'file', 'gradio.filedata', 'filedata', 'audio'].some((candidate) => type.includes(candidate));
}

function scoreInferenceEndpoint(parameters, returns) {
  if (!Array.isArray(parameters)) return 0;

  const names = parameters.map(getParameterName);
  const labels = parameters.map(getParameterLabel);
  const returnLabels = (returns || []).map((item) => (item?.label || '').toString().toLowerCase());

  if (names.some((name) => name === 'input_folder' || name.includes('batch'))) return -1;
  if (labels.some((label) => ['text to synthesize', 'dataset path', 'total epoch', 'input device'].some((term) => label.includes(term)))) {
    return -1;
  }

  let score = 0;
  if (labels.some((label) => label.includes('pitch'))) score += 1;
  if (labels.some((label) => label.includes('voice model'))) score += 1;
  if (labels.some((label) => label.includes('index file'))) score += 1;
  if (labels.some((label) => label.includes('select audio') || label.includes('input audio'))) score += 2;
  if (labels.some((label) => label.includes('output path') || label.includes('output audio'))) score += 1;
  if (returnLabels.some((label) => label.includes('conversion output'))) score += 2;
  if (returnLabels.some((label) => label.includes('export audio'))) score += 2;

  for (const field of ['pth_path', 'index_path', 'pitch', 'input_audio_path']) {
    if (names.includes(field)) score += 1;
  }

  return score;
}

function findAudioUploadEndpoint(entries) {
  const preferred = entries.find(([key]) => key.replace(/^\/+/, '') === 'save_to_wav2')
    ?? entries.find(([key]) => key.replace(/^\/+/, '') === 'save_to_wav');
  const candidates = preferred ? [preferred, ...entries.filter(([key]) => key !== preferred[0])] : entries;

  for (const [key, definition] of candidates) {
    const parameters = Array.isArray(definition?.parameters) ? definition.parameters : [];
    const returnLabels = (definition?.returns ?? []).map((item) => (item?.label || '').toString().toLowerCase());
    const hasAudioInput = parameters.some((param) => getComponent(param) === 'audio' || getComponent(param) === 'file');
    const hasSelectAudio = returnLabels.some((label) => label.includes('select audio'));
    const hasOutputPath = returnLabels.some((label) => label.includes('output path'));

    if (hasAudioInput && hasSelectAudio && hasOutputPath) {
      return { name: key.replace(/^\/+/, ''), parameters };
    }
  }

  return null;
}

async function getEndpoints(signal) {
  if (cachedEndpoints) return cachedEndpoints;
  if (endpointDiscoveryPromise) return endpointDiscoveryPromise;

  endpointDiscoveryPromise = (async () => {
    const info = await fetchGradioInfo(signal);
    const groups = [info?.named_endpoints ?? {}, info?.unnamed_endpoints ?? {}];
    const entries = groups.flatMap((group) => Object.entries(group));
    const availableKeys = entries.map(([key]) => key);

    let inference = null;
    let bestScore = 0;

    for (const [key, definition] of entries) {
      const parameters = Array.isArray(definition?.parameters) ? definition.parameters : [];
      const returns = Array.isArray(definition?.returns) ? definition.returns : [];
      const score = scoreInferenceEndpoint(parameters, returns);
      if (score > bestScore) {
        bestScore = score;
        inference = { name: key.replace(/^\/+/, ''), parameters, returns };
      }
    }

    if (!inference) {
      const keys = availableKeys.length > 0 ? availableKeys.join(', ') : '(none)';
      throw new Error(`Could not find RVC inference endpoint in Gradio API info. Available endpoints: ${keys}`);
    }

    cachedEndpoints = {
      inference,
      upload: findAudioUploadEndpoint(entries),
    };
    return cachedEndpoints;
  })();

  try {
    return await endpointDiscoveryPromise;
  } finally {
    endpointDiscoveryPromise = null;
  }
}

function parseSseEvents(sseText) {
  let completeData = null;

  for (const block of sseText.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let eventName = 'message';
    const dataLines = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const rawData = dataLines.join('\n');
    if (eventName === 'error') {
      throw new Error(`Gradio SSE error: ${rawData || 'unknown error'}`);
    }
    if (eventName === 'complete') {
      completeData = rawData ? JSON.parse(rawData) : null;
    }
  }

  return completeData;
}

async function callGradio(endpointName, data, signal) {
  const callUrl = `${config.rvcApiUrl}/gradio_api/call/${endpointName}`;
  const postRes = await fetch(callUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal,
  });

  if (!postRes.ok) {
    throw new Error(`Gradio call ${endpointName} POST failed with HTTP ${postRes.status}`);
  }

  if ((postRes.headers.get('content-type') || '').includes('text/event-stream')) {
    return parseSseEvents(await postRes.text());
  }

  const { event_id: eventId } = await postRes.json();
  if (!eventId) {
    throw new Error(`Gradio call ${endpointName} response missing event_id`);
  }

  const sseRes = await fetch(`${callUrl}/${eventId}`, { signal });
  if (!sseRes.ok) {
    throw new Error(`Gradio SSE GET for ${endpointName} failed with HTTP ${sseRes.status}`);
  }

  return parseSseEvents(await sseRes.text());
}

async function uploadWavToGradio(inputWavPath, signal) {
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(inputWavPath)], { type: 'audio/wav' }), path.basename(inputWavPath));

  const res = await fetch(`${config.rvcApiUrl}/gradio_api/upload`, {
    method: 'POST',
    body: form,
    signal,
  });

  if (!res.ok) {
    throw new Error(`Gradio upload failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  const uploadedPath = Array.isArray(data) ? data[0] : data;
  if (typeof uploadedPath !== 'string') {
    throw new Error('Gradio upload response missing file path');
  }

  return uploadedPath;
}

function findAudioParameter(parameters) {
  return parameters.find((param) => getParameterLabel(param).includes('select audio'))
    ?? parameters.find((param) => ['input_audio_path', 'input_audio', 'audio', 'audio_path'].includes(getParameterName(param)))
    ?? parameters.find((param) => getComponent(param) === 'audio' || isFileParameter(param));
}

async function prepareAudioInput(endpoint, uploadEndpoint, inputWavPath, outputWavPath, signal) {
  const audioParam = findAudioParameter(endpoint.parameters);

  if (audioParam && getParameterLabel(audioParam).includes('select audio') && uploadEndpoint) {
    const uploadedPath = await uploadWavToGradio(inputWavPath, signal);
    const fileData = { path: uploadedPath, meta: { _type: 'gradio.FileData' } };
    const saved = await callGradio(uploadEndpoint.name, [fileData], signal);

    if (!Array.isArray(saved) || typeof saved[0] !== 'string') {
      throw new Error(`Gradio ${uploadEndpoint.name} did not return a selectable audio path`);
    }

    return {
      audioValue: saved[0],
      outputPath: typeof saved[1] === 'string' ? saved[1] : outputWavPath,
      uploadedPath,
    };
  }

  if (audioParam && (getComponent(audioParam) === 'audio' || getComponent(audioParam) === 'file' || isFileParameter(audioParam))) {
    const uploadedPath = await uploadWavToGradio(inputWavPath, signal);
    return {
      audioValue: { path: uploadedPath, meta: { _type: 'gradio.FileData' } },
      outputPath: outputWavPath,
      uploadedPath,
    };
  }

  return { audioValue: inputWavPath, outputPath: outputWavPath, uploadedPath: null };
}

function normalizeApplioPath(value) {
  return typeof value === 'string' ? value.replace(/\//g, '\\') : value;
}

function buildPayload(parameters, audioInput) {
  const nameOverrides = {
    input_audio_path: audioInput.audioValue,
    input_audio: audioInput.audioValue,
    audio: audioInput.audioValue,
    audio_path: audioInput.audioValue,
    output_audio_path: audioInput.outputPath,
    pth_path: normalizeApplioPath(config.rvcModelPath),
    index_path: normalizeApplioPath(config.rvcIndexPath),
    pitch: config.rvcPitch,
    index_rate: config.rvcIndexRate,
    f0_method: 'rmvpe',
  };

  const labelOverrides = [
    { match: 'pitch extraction algorithm', value: 'rmvpe' },
    { match: 'search feature ratio', value: config.rvcIndexRate },
    { match: 'select audio', value: audioInput.audioValue },
    { match: 'output path', value: audioInput.outputPath },
    { match: 'voice model', value: normalizeApplioPath(config.rvcModelPath) },
    { match: 'index file', value: normalizeApplioPath(config.rvcIndexPath) },
    { match: 'i agree to the terms of use', value: true },
    { match: 'pitch', value: config.rvcPitch, exclude: ['proposed pitch'] },
  ];

  return parameters.map((param) => {
    const name = getParameterName(param);
    const label = getParameterLabel(param);

    if (Object.prototype.hasOwnProperty.call(nameOverrides, name)) {
      return nameOverrides[name];
    }

    for (const rule of labelOverrides) {
      if (!label.includes(rule.match)) continue;
      if (rule.exclude?.some((term) => label.includes(term))) continue;
      return rule.value;
    }

    if (param.parameter_has_default || Object.prototype.hasOwnProperty.call(param, 'parameter_default')) {
      return param.parameter_default;
    }
    if (Object.prototype.hasOwnProperty.call(param, 'default')) {
      return param.default;
    }
    return null;
  });
}

function collectFileCandidates(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFileCandidates(item, result);
    return result;
  }

  if (value && typeof value === 'object') {
    for (const key of ['path', 'url', 'orig_name']) {
      if (typeof value[key] === 'string') result.push(value[key]);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') collectFileCandidates(nested, result);
    }
    return result;
  }

  if (typeof value === 'string' && /\.(wav|mp3|flac|ogg|m4a)$/i.test(value.trim())) {
    result.push(value.trim());
  }
  return result;
}

function looksLikeWav(buffer) {
  return Boolean(buffer) &&
    buffer.length > 44 &&
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WAVE';
}

async function readCandidate(candidate, signal) {
  try {
    if (/^https?:\/\//i.test(candidate)) {
      const res = await fetch(candidate, { signal });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    if (candidate.startsWith('/')) {
      const res = await fetch(`${config.rvcApiUrl}${candidate}`, { signal });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    return await fs.readFile(candidate);
  } catch {
    return null;
  }
}

async function resolveOutputBuffer(completeData, outputWavPath, signal) {
  for (const candidate of collectFileCandidates(completeData)) {
    const buffer = await readCandidate(candidate, signal);
    if (looksLikeWav(buffer)) return buffer;
  }

  const localBuffer = await readCandidate(outputWavPath, signal);
  if (looksLikeWav(localBuffer)) return localBuffer;

  const raw = JSON.stringify(completeData) ?? 'null';
  const detail = raw.length > 4000 ? `${raw.slice(0, 4000)}...` : raw;
  throw new Error(`RVC output audio file missing or empty. Gradio complete data: ${detail}`);
}

export async function convert(pcm24kBuffer) {
  const wavBuffer = createWavBuffer(pcm24kBuffer);

  if (!config.rvcEnabled) {
    return wavBuffer;
  }

  const id = randomUUID();
  const inputWavPath = path.join(os.tmpdir(), `durin-rvc-in-${id}.wav`);
  const outputWavPath = path.join(os.tmpdir(), `durin-rvc-out-${id}.wav`);
  let uploadedPath = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('RVC conversion timed out')), RVC_TIMEOUT_MS);

  try {
    await fs.writeFile(inputWavPath, wavBuffer);

    const { inference, upload } = await getEndpoints(controller.signal);
    const audioInput = await prepareAudioInput(inference, upload, inputWavPath, outputWavPath, controller.signal);
    uploadedPath = audioInput.uploadedPath;
    const data = buildPayload(inference.parameters, audioInput);
    const completeData = await callGradio(inference.name, data, controller.signal);

    return await resolveOutputBuffer(completeData, outputWavPath, controller.signal);
  } catch (err) {
    console.warn(`[RVC] Conversion failed, falling back to original audio: ${err.message}`);
    return wavBuffer;
  } finally {
    clearTimeout(timeout);
    const cleanup = [inputWavPath, outputWavPath];
    if (uploadedPath && !uploadedPath.startsWith(os.tmpdir())) {
      cleanup.push(uploadedPath);
    }
    await Promise.all(cleanup.map((file) => fs.unlink(file).catch(() => {})));
  }
}
