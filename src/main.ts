import './style.css';
import { channelsToBuffer, createAudioContext, decodeAudio, looksLikeAudio, sliceChannels } from './audio/load';
import { RegionPlayer } from './audio/player';
import { DEMO_TRACK, demoTrackUrl } from './demo';
import { EngineClient } from './engine/client';
import { mixToMono } from './engine/mono';
import { WaveformView } from './ui/waveform';

// Safari before 14.1 only exposed the prefixed constructor. Checking both lets
// us give a clear message instead of failing later with a cryptic error.
// The TypeScript DOM types declare AudioContext as always present, so we look it
// up loosely: on an old browser the property genuinely may not exist.
type MaybeAudioGlobals = { AudioContext?: unknown; webkitAudioContext?: unknown };

function hasWebAudio(scope: MaybeAudioGlobals): boolean {
  return typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function';
}

// If an element is missing the HTML and script are out of sync; failing loudly
// in the console is more useful than silently doing nothing.
function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Masked: ${selector} not found in index.html`);
  return el;
}

const statusEl = $<HTMLElement>('#status');
const fileInput = $<HTMLInputElement>('#file-input');
const demoButton = $<HTMLButtonElement>('#demo-button');
const editor = $<HTMLElement>('#editor');
const fileNameEl = $<HTMLElement>('#file-name');
const regionLabel = $<HTMLElement>('#region-label');
const offsetInput = $<HTMLInputElement>('#offset');
const offsetValue = $<HTMLOutputElement>('#offset-value');
const processButton = $<HTMLButtonElement>('#process-button');
const removedReadout = $<HTMLElement>('#removed-readout');
const playButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-play]'));

function setStatus(message: string, state: 'ok' | 'error' | 'info' = 'info'): void {
  statusEl.textContent = message;
  statusEl.dataset.state = state;
}

type PlayMode = 'original' | 'processed' | 'removed';

interface LoadedSong {
  name: string;
  buffer: AudioBuffer;
}

/** A processing result is only valid for the exact region and offset it was made from. */
interface ProcessedRegion {
  startSample: number;
  offsetDb: number;
  processed: AudioBuffer;
  removed: AudioBuffer;
}

// The audio context is created on the first user action, not at page load:
// browsers (iOS Safari especially) keep audio locked until a gesture.
let audioContext: AudioContext | null = null;
let player: RegionPlayer | null = null;
let engine: EngineClient | null = null;
let song: LoadedSong | null = null;
let processedRegion: ProcessedRegion | null = null;
let playingMode: PlayMode | null = null;
let loadToken = 0;

const waveform = new WaveformView($<HTMLCanvasElement>('#waveform'), () => {
  // Moving the region makes any earlier result describe the wrong audio.
  player?.stop();
  invalidateProcessed();
  updateRegionLabel();
});

function ensureAudio(): { context: AudioContext; player: RegionPlayer } {
  if (!audioContext || !player) {
    audioContext = createAudioContext();
    player = new RegionPlayer(audioContext, () => {
      playingMode = null;
      updatePlayButtons();
    });
  }
  return { context: audioContext, player };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function updateRegionLabel(): void {
  const start = waveform.regionStart;
  regionLabel.textContent =
    `Test section: ${formatTime(start)} to ${formatTime(start + waveform.regionDuration)}. ` +
    'Drag it, or tap where you want it.';
}

function regionStartSample(): number {
  return song ? Math.round(waveform.regionStart * song.buffer.sampleRate) : 0;
}

function regionLengthSamples(): number {
  return song ? Math.round(waveform.regionDuration * song.buffer.sampleRate) : 0;
}

function invalidateProcessed(): void {
  if (!processedRegion) return;
  if (playingMode === 'processed' || playingMode === 'removed') player?.stop();
  processedRegion = null;
  removedReadout.textContent = 'Settings changed. Press Process again.';
  updatePlayButtons();
}

function updatePlayButtons(): void {
  for (const button of playButtons) {
    const mode = button.dataset.play as PlayMode;
    button.disabled = mode !== 'original' && !processedRegion;
    button.setAttribute('aria-pressed', String(mode === playingMode));
  }
}

async function loadSong(name: string, readData: () => Promise<ArrayBuffer>): Promise<void> {
  // If a second file is chosen while the first is still decoding, only the
  // newest one may take over the page.
  const token = ++loadToken;
  let context: AudioContext;
  try {
    context = ensureAudio().context;
  } catch (error) {
    setStatus((error as Error).message, 'error');
    return;
  }
  player?.stop();
  setStatus(`Decoding ${name}...`);
  try {
    const buffer = await decodeAudio(context, await readData());
    if (token !== loadToken) return;
    song = { name, buffer };
    processedRegion = null;
    removedReadout.textContent = '';
    editor.hidden = false;
    fileNameEl.textContent = `${name} (${formatTime(buffer.duration)}, ${buffer.numberOfChannels === 1 ? 'mono' : 'stereo'})`;
    // The waveform is drawn from a mono mix; playback keeps every channel.
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    waveform.setAudio(mixToMono(channels), buffer.sampleRate);
    updateRegionLabel();
    updatePlayButtons();
    setStatus('Loaded. Pick a 10-second section, then press Process.', 'ok');
  } catch (error) {
    if (token === loadToken) setStatus((error as Error).message, 'error');
  }
}

function loadFile(file: File): void {
  if (!looksLikeAudio(file)) {
    setStatus(`${file.name} does not look like an audio file.`, 'error');
    return;
  }
  void loadSong(file.name, () => file.arrayBuffer());
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  // Clearing the value lets the same file be chosen again later.
  fileInput.value = '';
});

// Accept drops anywhere on the page: a small drop target is fiddly to hit.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  // dragleave fires for every child element crossed, so count depth instead
  // of removing the highlight on the first one.
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => {
  // Without preventDefault the browser refuses the drop (and may open the file).
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

if (DEMO_TRACK) {
  const demo = DEMO_TRACK;
  demoButton.hidden = false;
  demoButton.addEventListener('click', () => {
    void loadSong(demo.title, async () => {
      const response = await fetch(demoTrackUrl(demo.file));
      if (!response.ok) throw new Error(`Could not download the demo track (HTTP ${response.status}).`);
      return response.arrayBuffer();
    });
  });
}

offsetInput.addEventListener('input', () => {
  const value = Number(offsetInput.value);
  offsetValue.textContent = `${value > 0 ? '+' : ''}${value} dB`;
  invalidateProcessed();
});

processButton.addEventListener('click', async () => {
  if (!song || !audioContext) return;
  const startSample = regionStartSample();
  const offsetDb = Number(offsetInput.value);
  const { buffer } = song;
  // Created lazily so a browser that cannot start module workers still gets
  // file loading and playback, and sees the error only when processing.
  engine ??= new EngineClient();

  processButton.disabled = true;
  removedReadout.textContent = 'Processing...';
  try {
    const result = await engine.process(
      sliceChannels(buffer, startSample, regionLengthSamples()),
      buffer.sampleRate,
      offsetDb,
    );
    // The user may have moved the region or slider while we waited.
    if (startSample !== regionStartSample() || offsetDb !== Number(offsetInput.value)) return;
    processedRegion = {
      startSample,
      offsetDb,
      processed: channelsToBuffer(audioContext, result.processed, buffer.sampleRate),
      removed: channelsToBuffer(audioContext, result.removed, buffer.sampleRate),
    };
    removedReadout.textContent =
      `Removed ${result.percentRemoved.toFixed(2)}% of the energy in this section ` +
      `(${Math.round(result.elapsedMs)} ms).`;
    updatePlayButtons();
  } catch (error) {
    removedReadout.textContent = '';
    setStatus(`Processing failed: ${(error as Error).message}`, 'error');
  } finally {
    processButton.disabled = false;
  }
});

function bufferFor(mode: PlayMode, context: AudioContext): AudioBuffer | null {
  if (!song) return null;
  if (mode === 'original') {
    return channelsToBuffer(
      context,
      sliceChannels(song.buffer, regionStartSample(), regionLengthSamples()),
      song.buffer.sampleRate,
    );
  }
  if (!processedRegion) return null;
  return mode === 'processed' ? processedRegion.processed : processedRegion.removed;
}

for (const button of playButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.play as PlayMode;
    const { context, player: activePlayer } = ensureAudio();
    // Pressing the button of what is already playing stops it.
    if (playingMode === mode) {
      activePlayer.stop();
      return;
    }
    const buffer = bufferFor(mode, context);
    if (!buffer) return;
    activePlayer.play(buffer);
    playingMode = mode;
    updatePlayButtons();
    animatePlayhead();
  });
}

function animatePlayhead(): void {
  const position = player?.position() ?? null;
  waveform.setPlayhead(position === null ? null : waveform.regionStart + position);
  if (position !== null) requestAnimationFrame(animatePlayhead);
}

if (hasWebAudio(window as MaybeAudioGlobals)) {
  setStatus('Choose a song to begin. It stays on your device; nothing is uploaded.');
} else {
  setStatus(
    'Your browser does not support the Web Audio API, which Masked needs to process audio. ' +
      'Try a current version of Chrome, Firefox, Edge or Safari.',
    'error',
  );
  fileInput.disabled = true;
}
