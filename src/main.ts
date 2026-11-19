import './style.css';
import { bestPassage, topMoments } from './analysis/highlights';
import {
  applyEdgeFades,
  channelsToBuffer,
  createAudioContext,
  decodeAudio,
  looksLikeAudio,
  sliceChannels,
} from './audio/load';
import { SyncedPlayer, type Mix } from './audio/synced-player';
import { DEMO_TRACK, demoTrackUrl } from './demo';
import { CancelledError, EngineClient, type AnalysisJob } from './engine/client';
import { PEAK_CEILING, samplePeak } from './engine/loudness';
import { mixToMono } from './engine/mono';
import type { AnalyzeResponse } from './engine/protocol';
import { MaskingMapView } from './ui/masking-map';
import { TestFlow, type Intent, type Step } from './ui/test-flow';
import { REGION_SECONDS, WaveformView } from './ui/waveform';

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

/** "+20 dB" boost for the removed-only version. Exploration only: the quiz
 *  never plays the removed audio at all. */
const REMOVED_BOOST = 10;
/** Whole-song analysis keeps the original and the processed song in memory.
 *  Past about 15 minutes that is more than many phones allow a single tab. */
const MAX_SONG_SECONDS = 15 * 60;

const views = { home: $<HTMLElement>('#view-home'), song: $<HTMLElement>('#view-song'), test: $<HTMLElement>('#test') };
const stepperItems = Array.from(document.querySelectorAll<HTMLLIElement>('.stepper li'));
const toast = $<HTMLElement>('#toast');
const fileInput = $<HTMLInputElement>('#file-input');
const demoButton = $<HTMLButtonElement>('#demo-button');
const intentPrompt = $<HTMLElement>('#intent-prompt');
const intentCards = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-intent]'));
const songTitle = $<HTMLElement>('#song-title');
const songMeta = $<HTMLElement>('#song-meta');
const intentNote = $<HTMLElement>('#intent-note');
const progressPanel = $<HTMLElement>('#analysis-progress');
const progressFill = $<HTMLElement>('#progress-fill');
const progressLabel = $<HTMLElement>('#progress-label');
const errorPanel = $<HTMLElement>('#analysis-error');
const errorText = $<HTMLElement>('#analysis-error-text');
const mapHeadline = $<HTMLElement>('#map-headline');
const mapSub = $<HTMLElement>('#map-sub');
const mapEmpty = $<HTMLElement>('#map-empty');
const momentsEl = $<HTMLElement>('#moments');
const versionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-play]'));
const playToggle = $<HTMLButtonElement>('#play-toggle');
const timeReadout = $<HTMLElement>('#time-readout');
const boostInput = $<HTMLInputElement>('#boost');
const offsetInput = $<HTMLInputElement>('#offset');
const offsetValue = $<HTMLOutputElement>('#offset-value');
const reanalyzeButton = $<HTMLButtonElement>('#reanalyze');
const passageLength = $<HTMLInputElement>('#passage-length');
const passageLengthValue = $<HTMLOutputElement>('#passage-length-value');
const passageButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-passage]'));
const regionLabel = $<HTMLElement>('#region-label');
const startTestButton = $<HTMLButtonElement>('#start-test');
const testSetup = $<HTMLElement>('#test-setup');

type Version = 'original' | 'processed' | 'removed';

interface LoadedSong {
  name: string;
  buffer: AudioBuffer;
  /** Shared gain that keeps the original below the peak ceiling. */
  originalHeadroom: number;
}

interface Analysis {
  offsetDb: number;
  processed: AudioBuffer;
  /** Linear loudness-matching gain already applied to `processed`. */
  gain: number;
  /** Shared playback gain that keeps every version below the peak ceiling. */
  headroom: number;
  /** Boost actually used for "Removed": up to +20 dB, less if that would clip. */
  removedBoost: number;
}

// ---- State -------------------------------------------------------------

let intent: Intent = 'wasted';
let intentChosen = false;
// The audio context is created on the first user action, not at page load:
// browsers (iOS Safari especially) keep audio locked until a gesture.
let audioContext: AudioContext | null = null;
let player: SyncedPlayer | null = null;
let engine: EngineClient | null = null;
let testFlow: TestFlow | null = null;
let song: LoadedSong | null = null;
let analysis: Analysis | null = null;
/** Per-frame stats at offset 0, the standard model: the auto-picked passage
 *  is defined on these even after re-analysing at another offset. */
let baseline: AnalyzeResponse['frames'] | null = null;
let job: AnalysisJob | null = null;
let loadToken = 0;
let selected: Version = 'original';
let pausedAt = 0;
let passageMode: 'auto' | 'manual' = 'auto';

// ---- Small helpers -------------------------------------------------------

let toastTimer = 0;
function showToast(message: string, state: 'info' | 'error' = 'info'): void {
  toast.textContent = message;
  toast.dataset.state = state;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), state === 'error' ? 8000 : 4000);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

type StepperStep = 'song' | 'headphones' | 'test' | 'results';
const STEPPER_ORDER: StepperStep[] = ['song', 'headphones', 'test', 'results'];

function setStepper(current: StepperStep | null): void {
  const index = current ? STEPPER_ORDER.indexOf(current) : -1;
  stepperItems.forEach((li, i) => {
    li.classList.toggle('is-current', i === index);
    li.classList.toggle('is-done', i < index);
    if (i === index) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
}

function showView(name: keyof typeof views): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  if (name === 'home') setStepper(null);
  if (name === 'song') setStepper('song');
  window.scrollTo({ top: 0 });
}

function ensureAudio(): { context: AudioContext; player: SyncedPlayer } {
  if (!audioContext || !player) {
    audioContext = createAudioContext();
    player = new SyncedPlayer(audioContext, updateTransport);
  }
  return { context: audioContext, player };
}

function ensureEngine(): EngineClient {
  // Created lazily so a browser that cannot start module workers still gets
  // file loading and playback, and sees the error only when analysing.
  engine ??= new EngineClient();
  return engine;
}

// ---- Use cases -----------------------------------------------------------

const INTENT_PROMPTS: Record<Intent, string> = {
  lossless: 'Choose a song you know well, ideally a lossless file',
  wasted: 'Choose the mix you want to inspect',
  fatigue: 'Choose a song to use for every check today',
};

const INTENT_NOTES: Record<Intent, string> = {
  lossless:
    'Next: check the passage below and take the listening test. If you cannot tell the versions apart ' +
    'even when more than the standard model is removed, a good lossy format is likely transparent for ' +
    'you on this song.',
  wasted:
    'Amber is sound buried under louder sound. Tap the map to play any moment, then switch to Removed ' +
    'to hear only what is buried there.',
  fatigue:
    'Use the same song and passage every time. Take the test now and again after a long listening ' +
    'session; results are kept on this device so you can compare.',
};

for (const card of intentCards) {
  card.addEventListener('click', () => {
    intent = card.dataset.intent as Intent;
    intentChosen = true;
    intentCards.forEach((c) => c.setAttribute('aria-pressed', String(c === card)));
    intentPrompt.textContent = INTENT_PROMPTS[intent];
    if (song) {
      showView('song');
      applyIntent();
    } else {
      $('#drop-zone').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function applyIntent(): void {
  intentNote.hidden = !intentChosen;
  intentNote.textContent = INTENT_NOTES[intent];
  // Once the analysis is in, lead each use case to its part of the page.
  if (analysis && intentChosen && intent !== 'wasted') {
    testSetup.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---- Loading a song ------------------------------------------------------

async function loadSong(name: string, readData: () => Promise<ArrayBuffer>): Promise<void> {
  // If a second file is chosen while the first is still decoding, only the
  // newest one may take over the page.
  const token = ++loadToken;
  let context: AudioContext;
  try {
    context = ensureAudio().context;
  } catch (error) {
    showToast((error as Error).message, 'error');
    return;
  }
  job?.cancel();
  job = null;
  player?.stop();
  song = null;
  analysis = null;
  baseline = null;
  pausedAt = 0;
  selected = 'original';
  map.clear();
  momentsEl.replaceChildren();

  showView('song');
  songTitle.textContent = name;
  songMeta.textContent = 'Decoding...';
  setAnalysisState('decoding');
  updateTransport();

  try {
    const buffer = await decodeAudio(context, await readData());
    if (token !== loadToken) return;
    if (buffer.duration > MAX_SONG_SECONDS) {
      throw new Error(`That file is ${formatTime(buffer.duration)} long. Masked handles up to 15 minutes.`);
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    song = { name, buffer, originalHeadroom: Math.min(1, PEAK_CEILING / Math.max(samplePeak(channels), 1e-9)) };
    songMeta.textContent =
      `${formatTime(buffer.duration)} · ${buffer.numberOfChannels === 1 ? 'mono' : 'stereo'} · ` +
      `${(buffer.sampleRate / 1000).toFixed(1)} kHz`;
    // The waveform is drawn from a mono mix; playback keeps every channel.
    waveform.setAudio(mixToMono(channels), buffer.sampleRate);
    waveform.setRegion(0, Number(passageLength.value));
    updateRegionLabel();
    reloadPlayer();
    applyIntent();
    void runAnalysis(0);
  } catch (error) {
    if (token !== loadToken) return;
    showView('home');
    showToast((error as Error).message, 'error');
  }
}

function loadFile(file: File): void {
  if (testFlow?.isActive) {
    showToast('Finish or exit the test before loading another song.', 'error');
    return;
  }
  if (!looksLikeAudio(file)) {
    showToast(`${file.name} does not look like an audio file.`, 'error');
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

$('#change-song').addEventListener('click', () => {
  job?.cancel();
  job = null;
  player?.stop();
  showView('home');
});

// ---- Whole-song analysis ---------------------------------------------------

function setAnalysisState(state: 'decoding' | 'running' | 'done' | 'error', message = ''): void {
  progressPanel.hidden = state !== 'running' && state !== 'decoding';
  errorPanel.hidden = state !== 'error';
  mapEmpty.hidden = state === 'done';
  reanalyzeButton.disabled = state === 'running' || state === 'decoding' || !song;
  startTestButton.disabled = !baseline;
  if (state === 'decoding') {
    progressLabel.textContent = 'Decoding the file...';
    progressFill.style.width = '0%';
    mapHeadline.textContent = 'Reading your song...';
    mapSub.textContent = '';
  }
  if (state === 'error') {
    errorText.textContent = message;
    if (!analysis) mapHeadline.textContent = 'No map yet';
  }
}

function setProgress(fraction: number): void {
  const pct = Math.round(fraction * 100);
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${pct}%`;
  progressPanel.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(pct));
}

async function runAnalysis(offsetDb: number): Promise<void> {
  const current = song;
  if (!current) return;
  job?.cancel();
  setAnalysisState('running');
  setProgress(0);
  if (!analysis) mapHeadline.textContent = 'Analysing...';
  const { buffer } = current;
  // Copies, because the worker takes ownership of what it is sent; the
  // originals stay in the AudioBuffer for playback.
  const copies = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  let thisJob: AnalysisJob;
  try {
    thisJob = ensureEngine().analyze(copies, buffer.sampleRate, offsetDb, setProgress);
  } catch (error) {
    setAnalysisState('error', (error as Error).message);
    return;
  }
  job = thisJob;

  try {
    const r = await thisJob.result;
    if (job !== thisJob || song !== current || !audioContext) return;
    const headroom = r.loudness.headroom;
    const removedPeak = r.removedPeak * headroom;
    analysis = {
      offsetDb,
      processed: channelsToBuffer(audioContext, r.processed, buffer.sampleRate),
      gain: Math.pow(10, r.loudness.gainDb / 20),
      headroom,
      removedBoost: removedPeak > 0 ? Math.min(REMOVED_BOOST, PEAK_CEILING / removedPeak) : REMOVED_BOOST,
    };
    if (offsetDb === 0 || !baseline) baseline = r.frames;
    showAnalysis(r, offsetDb);
    setAnalysisState('done');
    reloadPlayer();
    if (passageMode === 'auto') applyAutoPassage();
    applyIntent();
  } catch (error) {
    if (error instanceof CancelledError || job !== thisJob) return;
    setAnalysisState('error', (error as Error).message);
  } finally {
    if (job === thisJob) job = null;
  }
}

function showAnalysis(r: AnalyzeResponse, offsetDb: number): void {
  if (!song) return;
  map.setData(r.map, song.buffer.duration);
  const moments = topMoments(r.frames.maskedBins, r.frames.frameSeconds);
  map.setMoments(moments.map((m) => m.timeSeconds));
  momentsEl.replaceChildren(
    ...moments.map((m, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'moment';
      const badge = document.createElement('b');
      badge.textContent = String(i + 1);
      chip.append(badge, `Most hidden detail at ${formatTime(m.timeSeconds)}`);
      chip.addEventListener('click', () => seekTo(m.timeSeconds));
      return chip;
    }),
  );

  const at = offsetDb === 0 ? 'the standard model' : `the model at ${offsetDb > 0 ? '+' : ''}${offsetDb} dB`;
  const pct = document.createElement('em');
  pct.textContent = `${r.maskedPercent.toFixed(0)}%`;
  mapHeadline.replaceChildren(pct, ` of this song's sound is inaudible to ${at}`);
  const energy = r.percentRemoved < 0.01 ? 'under 0.01' : r.percentRemoved.toFixed(2);
  mapSub.textContent =
    `That is ${energy}% of its energy: masked detail is quiet detail. ` +
    `Processed version loudness-matched at ${r.loudness.originalLufs.toFixed(1)} LUFS.`;
}

$('#cancel-analysis').addEventListener('click', () => {
  job?.cancel();
  job = null;
  setAnalysisState('error', 'Analysis cancelled. The original still plays; run it again when ready.');
});
$('#retry-analysis').addEventListener('click', () => void runAnalysis(Number(offsetInput.value)));
reanalyzeButton.addEventListener('click', () => void runAnalysis(Number(offsetInput.value)));
offsetInput.addEventListener('input', () => {
  const value = Number(offsetInput.value);
  offsetValue.textContent = `${value > 0 ? '+' : ''}${value} dB`;
});

// ---- Playback --------------------------------------------------------------

function versionMixes(): Record<string, Mix> {
  const versions: Record<string, Mix> = { original: { original: 1 } };
  if (analysis) {
    versions.processed = { processed: 1 };
    const b = boostInput.checked ? analysis.removedBoost : 1;
    // The removed audio is rebuilt live as original minus kept. The processed
    // source is loudness-matched (kept times gain), so the gain is divided back
    // out. Both sources are sample-locked, so the subtraction is exact.
    versions.removed = { original: b, processed: -b / analysis.gain };
  }
  return versions;
}

/** Loads the current sources, carrying on from the same place if playing. */
function reloadPlayer(): void {
  if (!song) return;
  const { player: p } = ensureAudio();
  const position = p.position();
  const wasPlaying = p.active !== null;
  const sources: Record<string, AudioBuffer> = { original: song.buffer };
  if (analysis) sources.processed = analysis.processed;
  p.load(sources, versionMixes(), analysis?.headroom ?? song.originalHeadroom);
  if (!analysis) selected = 'original';
  if (wasPlaying && position !== null) {
    p.play(selected, position);
    animate();
  }
  updateTransport();
}

function updateTransport(): void {
  const playing = player?.active ?? null;
  for (const button of versionButtons) {
    const mode = button.dataset.play as Version;
    button.disabled = mode !== 'original' && !analysis;
    button.setAttribute('aria-pressed', String(mode === selected));
  }
  playToggle.classList.toggle('is-playing', playing !== null);
  playToggle.setAttribute('aria-label', playing ? 'Stop' : 'Play');
  playToggle.disabled = !song;
  boostInput.disabled = !analysis;
  if (!playing) updateTime(pausedAt);
}

function updateTime(position: number): void {
  timeReadout.textContent = `${formatTime(position)} / ${formatTime(song?.buffer.duration ?? 0)}`;
}

function animate(): void {
  const position = player?.position() ?? null;
  map.setPlayhead(position);
  waveform.setPlayhead(position);
  if (position !== null) {
    updateTime(position);
    requestAnimationFrame(animate);
  }
}

function togglePlay(): void {
  if (!song) return;
  const { player: p } = ensureAudio();
  if (p.active) {
    pausedAt = p.position() ?? 0;
    p.stop();
    return;
  }
  p.play(selected, pausedAt);
  animate();
}

function seekTo(seconds: number): void {
  if (!song) return;
  const { player: p } = ensureAudio();
  const wasPlaying = p.active !== null;
  pausedAt = seconds;
  p.seek(seconds, selected);
  if (!wasPlaying) animate();
}

playToggle.addEventListener('click', togglePlay);

for (const button of versionButtons) {
  button.addEventListener('click', () => {
    selected = button.dataset.play as Version;
    // While playing this crossfades at the current position; while stopped
    // it just chooses what Play will start.
    if (player?.active) player.play(selected);
    updateTransport();
  });
}

boostInput.addEventListener('change', () => {
  const mix = versionMixes().removed;
  if (mix) player?.setMix('removed', mix);
});

document.addEventListener('keydown', (e) => {
  // Space toggles playback on the song page, unless a control has focus
  // (where Space already means "press this").
  if (e.key !== ' ' || views.song.hidden) return;
  const target = e.target as HTMLElement;
  if (target.closest('button, input, select, textarea, summary, label')) return;
  e.preventDefault();
  togglePlay();
});

const map = new MaskingMapView($<HTMLCanvasElement>('#masking-map'), seekTo);

// ---- Test passage ---------------------------------------------------------

const waveform = new WaveformView($<HTMLCanvasElement>('#waveform'), () => {
  // Dragging means the user is choosing their own passage.
  setPassageMode('manual');
  updateRegionLabel();
});

function setPassageMode(mode: 'auto' | 'manual'): void {
  passageMode = mode;
  passageButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.passage === mode)));
}

function applyAutoPassage(): void {
  if (!song || !baseline) return;
  const length = Number(passageLength.value);
  const start = bestPassage(baseline.removedEnergy, baseline.frameSeconds, length, song.buffer.duration);
  waveform.setRegion(start, length);
  updateRegionLabel();
}

function updateRegionLabel(): void {
  const start = waveform.regionStart;
  const range = `${formatTime(start)} to ${formatTime(start + waveform.regionDuration)}`;
  if (passageMode === 'manual') regionLabel.textContent = `${range}. Drag it, or tap where you want it.`;
  else if (baseline) regionLabel.textContent = `${range}: where the standard model removes the most. Drag to choose your own.`;
  else regionLabel.textContent = 'The passage with the most hidden detail is picked once the analysis finishes.';
}

passageLength.addEventListener('input', () => {
  const length = Number(passageLength.value);
  passageLengthValue.textContent = `${length} s`;
  if (passageMode === 'auto') applyAutoPassage();
  else waveform.setRegion(waveform.regionStart, length);
  updateRegionLabel();
});

for (const button of passageButtons) {
  button.addEventListener('click', () => {
    setPassageMode(button.dataset.passage as 'auto' | 'manual');
    if (passageMode === 'auto') applyAutoPassage();
    updateRegionLabel();
  });
}

startTestButton.addEventListener('click', () => {
  if (!song) return;
  const { context, player: p } = ensureAudio();
  pausedAt = p.position() ?? pausedAt;
  p.stop();
  const { buffer } = song;
  const startSample = Math.round(waveform.regionStart * buffer.sampleRate);
  const length = Math.round(waveform.regionDuration * buffer.sampleRate);
  const channels = sliceChannels(buffer, startSample, length);
  // The passage loops in the test; fades at both ends stop the jump from
  // its last sample back to its first from clicking.
  applyEdgeFades(channels, buffer.sampleRate);

  testFlow ??= new TestFlow(
    context,
    ensureEngine(),
    () => showView('song'),
    (step: Step) => setStepper(step === 'quiz' ? 'test' : step === 'results' ? 'results' : 'headphones'),
  );
  showView('test');
  testFlow.begin({
    songName: song.name,
    startSeconds: waveform.regionStart,
    durationSeconds: waveform.regionDuration,
    sampleRate: buffer.sampleRate,
    channels,
    intent,
  });
});

// ---- Start-up --------------------------------------------------------------

passageLength.value = String(REGION_SECONDS);
passageLengthValue.textContent = `${REGION_SECONDS} s`;
showView('home');
if (!hasWebAudio(window as MaybeAudioGlobals)) {
  intentPrompt.textContent = 'This browser cannot run Masked';
  $('#drop-zone .drop-text').textContent =
    'Masked needs the Web Audio API to process sound. Try a current version of Chrome, Firefox, Edge or Safari.';
  fileInput.disabled = true;
}
