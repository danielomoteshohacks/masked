import './style.css';
import {
  applyEdgeFades,
  channelsToBuffer,
  createAudioContext,
  decodeAudio,
  looksLikeAudio,
  sliceChannels,
} from './audio/load';
import { SyncedPlayer } from './audio/synced-player';
import { DEMO_TRACK, demoTrackUrl } from './demo';
import { EngineClient } from './engine/client';
import { PEAK_CEILING, samplePeak } from './engine/loudness';
import { mixToMono } from './engine/mono';
import { TestFlow } from './ui/test-flow';
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
const boostInput = $<HTMLInputElement>('#boost');
const loader = $<HTMLElement>('#loader');
const startTestButton = $<HTMLButtonElement>('#start-test');

/** "+20 dB" boost for the removed-only version. It is exploration only:
 *  the quiz never plays the removed audio at all. */
const REMOVED_BOOST = 10;

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
  /** Shared playback gain that keeps every version below the peak ceiling. */
  headroom: number;
  /** Boost actually used: up to +20 dB, less if that would clip. */
  removedBoost: number;
}

// The audio context is created on the first user action, not at page load:
// browsers (iOS Safari especially) keep audio locked until a gesture.
let audioContext: AudioContext | null = null;
let player: SyncedPlayer | null = null;
let engine: EngineClient | null = null;
let song: LoadedSong | null = null;
let processedRegion: ProcessedRegion | null = null;
let loadToken = 0;
let testFlow: TestFlow | null = null;
/** Which region/result the player currently holds, so it is only reloaded when that changes. */
let loadedVersionsKey: string | null = null;

const waveform = new WaveformView($<HTMLCanvasElement>('#waveform'), () => {
  // Moving the region makes any earlier result describe the wrong audio.
  player?.stop();
  invalidateProcessed();
  updateRegionLabel();
});

function ensureAudio(): { context: AudioContext; player: SyncedPlayer } {
  if (!audioContext || !player) {
    audioContext = createAudioContext();
    player = new SyncedPlayer(audioContext, updatePlayButtons);
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

/** The selected region with its loop-edge fades, as fresh copies. */
function regionChannels(): Float32Array[] {
  if (!song) return [];
  const channels = sliceChannels(song.buffer, regionStartSample(), regionLengthSamples());
  applyEdgeFades(channels, song.buffer.sampleRate);
  return channels;
}

function invalidateProcessed(): void {
  // The player's versions describe the old settings; it reloads on next play.
  player?.stop();
  loadedVersionsKey = null;
  if (!processedRegion) return;
  processedRegion = null;
  removedReadout.textContent = 'Settings changed. Press Process again.';
  updatePlayButtons();
}

function updatePlayButtons(): void {
  for (const button of playButtons) {
    const mode = button.dataset.play as PlayMode;
    button.disabled = mode !== 'original' && !processedRegion;
    button.setAttribute('aria-pressed', String(mode === player?.active));
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
  loadedVersionsKey = null;
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
  if (testFlow?.isActive) {
    setStatus('Finish or exit the test before loading another song.', 'error');
    return;
  }
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
    const result = await engine.process(regionChannels(), buffer.sampleRate, offsetDb);
    // The user may have moved the region or slider while we waited.
    if (startSample !== regionStartSample() || offsetDb !== Number(offsetInput.value)) return;
    const { headroom } = result.loudness;
    const removedPeak = samplePeak(result.removed) * headroom;
    processedRegion = {
      startSample,
      offsetDb,
      processed: channelsToBuffer(audioContext, result.processed, buffer.sampleRate),
      removed: channelsToBuffer(audioContext, result.removed, buffer.sampleRate),
      headroom,
      removedBoost: removedPeak > 0 ? Math.min(REMOVED_BOOST, PEAK_CEILING / removedPeak) : REMOVED_BOOST,
    };
    player?.stop();
    loadedVersionsKey = null;
    const { originalLufs, gainDb } = result.loudness;
    removedReadout.textContent =
      `Removed ${result.percentRemoved.toFixed(2)}% of the energy in this section. ` +
      `Loudness matched: original ${originalLufs.toFixed(1)} LUFS, processed adjusted by ` +
      `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(2)} dB (${Math.round(result.elapsedMs)} ms).`;
    updatePlayButtons();
  } catch (error) {
    removedReadout.textContent = '';
    setStatus(`Processing failed: ${(error as Error).message}`, 'error');
  } finally {
    processButton.disabled = false;
  }
});

function removedLevel(): number {
  return boostInput.checked && processedRegion ? processedRegion.removedBoost : 1;
}

/** Loads every available version onto the player's shared timeline, if not already loaded. */
function ensureVersionsLoaded(context: AudioContext, activePlayer: SyncedPlayer): void {
  if (!song) return;
  const key = `${regionStartSample()}:${processedRegion ? processedRegion.offsetDb : 'none'}`;
  if (key === loadedVersionsKey) return;
  const channels = regionChannels();
  const original = channelsToBuffer(context, channels, song.buffer.sampleRate);
  if (processedRegion) {
    activePlayer.load(
      { original, processed: processedRegion.processed, removed: processedRegion.removed },
      processedRegion.headroom,
      { removed: removedLevel() },
    );
  } else {
    activePlayer.load({ original }, Math.min(1, PEAK_CEILING / Math.max(samplePeak(channels), 1e-9)));
  }
  loadedVersionsKey = key;
}

boostInput.addEventListener('change', () => player?.setLevel('removed', removedLevel()));

for (const button of playButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.play as PlayMode;
    const { context, player: activePlayer } = ensureAudio();
    // Pressing the button of what is already playing stops it.
    if (activePlayer.active === mode) {
      activePlayer.stop();
      return;
    }
    if (mode !== 'original' && !processedRegion) return;
    const wasPlaying = activePlayer.active !== null;
    ensureVersionsLoaded(context, activePlayer);
    // If already playing, this crossfades at the current position.
    activePlayer.play(mode);
    if (!wasPlaying) animatePlayhead();
  });
}

function animatePlayhead(): void {
  const position = player?.position() ?? null;
  waveform.setPlayhead(position === null ? null : waveform.regionStart + position);
  if (position !== null) requestAnimationFrame(animatePlayhead);
}

startTestButton.addEventListener('click', () => {
  if (!song) return;
  const { context, player: activePlayer } = ensureAudio();
  activePlayer.stop();
  engine ??= new EngineClient();
  testFlow ??= new TestFlow(context, engine, () => {
    loader.hidden = false;
    editor.hidden = false;
    setStatus('Test closed. You can explore, or start another test.');
  });
  loader.hidden = true;
  editor.hidden = true;
  setStatus('');
  testFlow.begin({
    songName: song.name,
    startSeconds: waveform.regionStart,
    durationSeconds: waveform.regionDuration,
    sampleRate: song.buffer.sampleRate,
    channels: regionChannels(),
  });
});

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
