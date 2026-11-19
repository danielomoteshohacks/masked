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
import { earScore } from './quiz/ear-score';
import { interpretThreshold } from './quiz/scoring';
import { download, Game, type Screen as GameScreen, type TestRegion } from './ui/game';
import { loadHistory } from './ui/history';
import { LiveWave, setAnalyser } from './ui/live-wave';
import { MaskingMapView } from './ui/masking-map';
import { renderStaircaseChart } from './ui/staircase-chart';
import { REGION_SECONDS, WaveformView } from './ui/waveform';

// Safari before 14.1 only exposed the prefixed constructor. Checking both lets
// us give a clear message instead of failing later with a cryptic error.
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

/** "+20 dB" boost for the removed-only version, in Studio mode only. */
const REMOVED_BOOST = 10;
/** Whole-song analysis keeps the original and the processed song in memory.
 *  Past about 15 minutes that is more than many phones allow a single tab. */
const MAX_SONG_SECONDS = 15 * 60;

type Screen = 'home' | GameScreen | 'studio';
const screens: Record<Screen, HTMLElement> = {
  home: $('#screen-home'),
  volume: $('#screen-volume'),
  tones: $('#screen-tones'),
  test: $('#screen-test'),
  score: $('#screen-score'),
  studio: $('#screen-studio'),
};

const flowProgress = $<HTMLElement>('#flow-progress');
const flowSteps = Array.from(flowProgress.querySelectorAll<HTMLLIElement>('li'));
const toast = $<HTMLElement>('#toast');
const fileInput = $<HTMLInputElement>('#file-input');
const startMain = $<HTMLButtonElement>('#start-main');
const ownSong = $<HTMLButtonElement>('#own-song');
const homeNote = $<HTMLElement>('#home-note');
const homeError = $<HTMLElement>('#home-error');

const studioTitle = $<HTMLElement>('#studio-title');
const studioMeta = $<HTMLElement>('#studio-meta');
const studioEmpty = $<HTMLElement>('#studio-empty');
const studioContent = $<HTMLElement>('#studio-content');
const studioResults = $<HTMLElement>('#studio-results');
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
const studioTest = $<HTMLButtonElement>('#studio-test');

type Version = 'original' | 'processed' | 'removed';
type Destination = 'game' | 'studio';

interface LoadedSong {
  name: string;
  buffer: AudioBuffer;
  /** Shared gain that keeps the original below the peak ceiling. */
  headroom: number;
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

/** A promise with its resolve/reject exposed: the test passage, picked once the analysis is in. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may be waiting yet; this stops an early failure being reported as unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

// ---- State -----------------------------------------------------------------

// The audio context is created on the first user action, not at page load:
// browsers (iOS Safari especially) keep audio locked until a gesture.
let audioContext: AudioContext | null = null;
let output: AnalyserNode | null = null;
let studioPlayer: SyncedPlayer | null = null;
let engine: EngineClient | null = null;
let game: Game | null = null;
let song: LoadedSong | null = null;
let analysis: Analysis | null = null;
/** Per-frame stats at the standard setting: the auto-picked passage is
 *  defined on these even after re-analysing at another offset. */
let baseline: AnalyzeResponse['frames'] | null = null;
let job: AnalysisJob | null = null;
let analysisProgress = 0;
let autoRegion: Deferred<TestRegion> = deferred();
let loadToken = 0;
let pendingDestination: Destination = 'game';
let currentScreen: Screen = 'home';
let selected: Version = 'original';
let pausedAt = 0;
let passageMode: 'auto' | 'manual' = 'auto';

// ---- Helpers -----------------------------------------------------------------

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

function show(screen: Screen): void {
  if (currentScreen === 'studio' && screen !== 'studio') {
    pausedAt = studioPlayer?.position() ?? pausedAt;
    studioPlayer?.stop();
  }
  currentScreen = screen;
  for (const [name, el] of Object.entries(screens)) el.hidden = name !== screen;

  // The three-part progress bar only belongs to the main flow.
  const order = ['headphones', 'test', 'score'];
  const step = screen === 'volume' || screen === 'tones' ? 'headphones' : screen;
  const index = order.indexOf(step);
  flowProgress.hidden = index < 0;
  flowSteps.forEach((li, i) => {
    li.classList.toggle('is-current', i === index);
    li.classList.toggle('is-done', i < index || (screen === 'score' && i <= index));
  });
  window.scrollTo({ top: 0 });
}

function ensureAudio(): AudioContext {
  if (!audioContext || !output) {
    audioContext = createAudioContext();
    // Everything plays through one analyser, so the waves can follow the music.
    output = audioContext.createAnalyser();
    output.fftSize = 1024;
    output.connect(audioContext.destination);
    setAnalyser(output);
    studioPlayer = new SyncedPlayer(audioContext, updateTransport, output);
  }
  return audioContext;
}

function ensureEngine(): EngineClient {
  // Created lazily so a browser that cannot start module workers still gets
  // the home page, and sees the error only when a song is loaded.
  engine ??= new EngineClient();
  return engine;
}

function ensureGame(): Game {
  const context = ensureAudio();
  if (!game && output) {
    game = new Game({
      context,
      engine: ensureEngine(),
      output,
      show,
      onQuit: () => show('home'),
      onOwnSong: () => pickFile('game'),
    });
  }
  if (!game) throw new Error('Audio is not available.');
  return game;
}

// ---- Home ----------------------------------------------------------------------

function setHomeBusy(busy: boolean): void {
  startMain.disabled = busy;
  startMain.textContent = busy ? 'Loading your song...' : DEMO_TRACK ? 'Take the 5-minute test' : 'Pick a song you love';
}

/** Opens the file picker. Must run inside a click, or browsers block it. */
function pickFile(destination: Destination): void {
  try {
    ensureAudio();
  } catch (error) {
    homeError.hidden = false;
    homeError.textContent = (error as Error).message;
    return;
  }
  pendingDestination = destination;
  fileInput.click();
}

function loadDemo(destination: Destination): void {
  const demo = DEMO_TRACK;
  if (!demo) return;
  try {
    ensureAudio();
  } catch (error) {
    showToast((error as Error).message, 'error');
    return;
  }
  void loadSong(
    demo.title,
    async () => {
      const response = await fetch(demoTrackUrl(demo.file));
      if (!response.ok) throw new Error("The demo song didn't load. Try your own song instead.");
      return response.arrayBuffer();
    },
    destination,
  );
}

startMain.addEventListener('click', () => {
  homeError.hidden = true;
  // Until the built-in demo song is added, the main button asks for a song.
  if (DEMO_TRACK) loadDemo('game');
  else pickFile('game');
});
ownSong.addEventListener('click', () => {
  homeError.hidden = true;
  pickFile('game');
});

for (const link of document.querySelectorAll<HTMLButtonElement>('[data-go-studio]')) {
  link.addEventListener('click', () => openStudio(link.dataset.goStudio === 'results'));
}

// ---- Loading a song ---------------------------------------------------------------

async function loadSong(name: string, readData: () => Promise<ArrayBuffer>, destination: Destination): Promise<void> {
  // If a second file is chosen while the first is still decoding, only the
  // newest one may take over.
  const token = ++loadToken;
  const context = ensureAudio();
  job?.cancel();
  job = null;
  studioPlayer?.stop();
  autoRegion.reject(new Error('A different song was chosen.'));
  autoRegion = deferred();
  song = null;
  analysis = null;
  baseline = null;
  analysisProgress = 0;
  pausedAt = 0;
  selected = 'original';
  map.clear();
  momentsEl.replaceChildren();
  setHomeBusy(true);
  if (destination === 'studio') {
    studioTitle.textContent = name;
    studioMeta.textContent = 'Opening...';
    setAnalysisState('running');
  }

  try {
    const buffer = await decodeAudio(context, await readData());
    if (token !== loadToken) return;
    if (buffer.duration > MAX_SONG_SECONDS) {
      throw new Error(`That song is ${formatTime(buffer.duration)} long. Pick one under 15 minutes.`);
    }
    if (buffer.duration < 3) throw new Error('That clip is too short. Pick a whole song.');
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    song = { name, buffer, headroom: Math.min(1, PEAK_CEILING / Math.max(samplePeak(channels), 1e-9)) };
    setHomeBusy(false);
    // The waveform (for choosing a passage in Studio mode) is drawn from a mono mix.
    waveform.setAudio(mixToMono(channels), buffer.sampleRate);
    waveform.setRegion(0, Number(passageLength.value));
    renderStudioSong();
    reloadStudioPlayer();
    void runAnalysis(0);

    if (destination === 'game') {
      const current = song;
      ensureGame().begin({
        name,
        buffer,
        headroom: current.headroom,
        region: autoRegion.promise,
        progress: () => analysisProgress,
      });
    } else {
      show('studio');
    }
  } catch (error) {
    if (token !== loadToken) return;
    setHomeBusy(false);
    const message =
      (error as Error).message.startsWith('This browser could not decode')
        ? "That file didn't play here. Try an MP3 or WAV."
        : (error as Error).message;
    if (destination === 'game') {
      show('home');
      homeError.hidden = false;
      homeError.textContent = message;
    } else {
      setAnalysisState('error', message);
      showToast(message, 'error');
    }
  }
}

function loadFile(file: File, destination: Destination): void {
  if (game?.isActive && destination === 'game' && currentScreen !== 'home' && currentScreen !== 'score') {
    showToast('Finish or quit the test before loading another song.', 'error');
    return;
  }
  if (!looksLikeAudio(file)) {
    const message = "That doesn't look like a song file. Try an MP3, WAV or M4A.";
    if (destination === 'game') {
      homeError.hidden = false;
      homeError.textContent = message;
    } else {
      showToast(message, 'error');
    }
    return;
  }
  void loadSong(file.name.replace(/\.[^.]+$/, ''), () => file.arrayBuffer(), destination);
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file, pendingDestination);
  // Clearing the value lets the same file be chosen again later.
  fileInput.value = '';
});

// Dropping a file works on the home screen (starts the game) and in Studio mode.
document.addEventListener('dragover', (e) => {
  // Without preventDefault the browser refuses the drop (and may open the file).
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  if (currentScreen === 'studio') loadFile(file, 'studio');
  else if (currentScreen === 'home' || currentScreen === 'score') loadFile(file, 'game');
});

// ---- Analysis -----------------------------------------------------------------------

function setAnalysisState(state: 'running' | 'done' | 'error', message = ''): void {
  progressPanel.hidden = state !== 'running';
  errorPanel.hidden = state !== 'error';
  mapEmpty.hidden = state === 'done';
  reanalyzeButton.disabled = state === 'running' || !song;
  studioTest.disabled = !baseline;
  if (state === 'error') errorText.textContent = message;
}

function setProgress(fraction: number): void {
  analysisProgress = fraction;
  const pct = Math.round(fraction * 100);
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${pct}%`;
  progressPanel.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(pct));
}

/** The test passage as fades-applied copies of the song's channels. */
function regionFrom(current: LoadedSong, startSeconds: number, lengthSeconds: number): TestRegion {
  const { buffer } = current;
  const length = Math.min(lengthSeconds, buffer.duration);
  const start = Math.min(Math.max(0, startSeconds), buffer.duration - length);
  const channels = sliceChannels(buffer, Math.round(start * buffer.sampleRate), Math.round(length * buffer.sampleRate));
  // The passage loops in the test; fades at both ends stop the jump from
  // its last sample back to its first from clicking.
  applyEdgeFades(channels, buffer.sampleRate);
  return { songName: current.name, startSeconds: start, durationSeconds: length, sampleRate: buffer.sampleRate, channels };
}

async function runAnalysis(offsetDb: number): Promise<void> {
  const current = song;
  if (!current || !audioContext) return;
  job?.cancel();
  setAnalysisState('running');
  setProgress(0);
  const { buffer } = current;
  // Copies, because the worker takes ownership of what it is sent; the
  // originals stay in the AudioBuffer for playback.
  const copies = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  let thisJob: AnalysisJob;
  try {
    thisJob = ensureEngine().analyze(copies, buffer.sampleRate, offsetDb, setProgress);
  } catch (error) {
    setAnalysisState('error', (error as Error).message);
    if (!baseline) autoRegion.reject(error as Error);
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
    if (offsetDb === 0 || !baseline) {
      baseline = r.frames;
      // The main flow tests the 10 s where the standard model removes the most:
      // where a difference is most likely to be audible.
      const start = bestPassage(r.frames.removedEnergy, r.frames.frameSeconds, REGION_SECONDS, buffer.duration);
      autoRegion.resolve(regionFrom(current, start, REGION_SECONDS));
    }
    showAnalysis(r, offsetDb);
    setAnalysisState('done');
    reloadStudioPlayer();
    if (passageMode === 'auto') applyAutoPassage();
  } catch (error) {
    if (job !== thisJob) return;
    if (error instanceof CancelledError) {
      setAnalysisState('error', 'Analysis cancelled. The original still plays; run it again when ready.');
    } else {
      setAnalysisState('error', (error as Error).message);
    }
    if (!baseline) autoRegion.reject(error as Error);
  } finally {
    if (job === thisJob) job = null;
  }
}

// ---- Studio mode ------------------------------------------------------------------------

function openStudio(scrollToResults: boolean): void {
  renderStudioSong();
  renderStudioResults();
  show('studio');
  if (scrollToResults && !studioResults.hidden) {
    requestAnimationFrame(() => studioResults.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}

function renderStudioSong(): void {
  studioEmpty.hidden = song !== null;
  studioContent.hidden = song === null;
  $('#studio-demo').hidden = DEMO_TRACK === null;
  if (!song) {
    studioTitle.textContent = 'Load a song';
    studioMeta.textContent = '';
    return;
  }
  const { buffer } = song;
  studioTitle.textContent = song.name;
  studioMeta.textContent =
    `${formatTime(buffer.duration)} · ${buffer.numberOfChannels === 1 ? 'mono' : 'stereo'} · ` +
    `${(buffer.sampleRate / 1000).toFixed(1)} kHz`;
  updateRegionLabel();
  updateTransport();
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
  mapHeadline.replaceChildren(pct, ` of the sound components are masked under ${at}.`);
  const energy = r.percentRemoved < 0.01 ? 'under 0.01' : r.percentRemoved.toFixed(2);
  mapSub.textContent =
    `That is ${energy}% of the energy: masked detail is quiet detail. ` +
    `Original ${r.loudness.originalLufs.toFixed(1)} LUFS; processed matched with ` +
    `${r.loudness.gainDb >= 0 ? '+' : ''}${r.loudness.gainDb.toFixed(2)} dB.`;
}

function renderStudioResults(): void {
  const result = game?.lastResult ?? null;
  studioResults.hidden = result === null;
  if (!result) return;
  const t = result.estimate.thresholdDb;
  const rows: [string, string][] = [
    ['Ear Score', `${earScore(t)} / 100`],
    ['Threshold', `${t > 0 ? '+' : ''}${t.toFixed(1)} dB vs the standard model${result.estimate.reliable ? '' : ' (low confidence)'}`],
    ['Reading', interpretThreshold(t)],
    ['Song and passage', `${result.songName}, ${formatTime(result.region.startSeconds)}, ${Math.round(result.region.durationSeconds)} s`],
    ['Correct', `${result.score.correct} of ${result.score.total} (${result.score.percentCorrect.toFixed(0)}%, chance 33%)`],
    ['p-value vs guessing', result.score.pValue < 0.001 ? '< 0.001' : result.score.pValue.toFixed(3)],
    ["d' (odd-one-out model)", result.score.dPrime.toFixed(2)],
    ['Reversals used', `${result.estimate.count} (${result.estimate.basis})`],
    [
      'Headphone check',
      result.headphones ? `${result.headphones.passed ? 'passed' : 'not passed'} (${result.headphones.correct} of 6)` : 'not run',
    ],
  ];
  $('#result-stats').replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
  $('#result-chart').innerHTML = renderStaircaseChart(result.trials, t);

  const history = loadHistory();
  $('#history-block').hidden = history.length < 2;
  $('#history-list').replaceChildren(
    ...history
      .slice(-8)
      .reverse()
      .map((entry) => {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.textContent = `${new Date(entry.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${entry.song}`;
        const value = document.createElement('b');
        value.textContent = `${earScore(entry.thresholdDb)} · ${entry.thresholdDb > 0 ? '+' : ''}${entry.thresholdDb.toFixed(1)} dB`;
        li.append(when, value);
        return li;
      }),
  );
}

$('#export-json').addEventListener('click', () => {
  const result = game?.lastResult;
  if (!result) return;
  const report = {
    app: 'Masked',
    note: 'Not a medical hearing test.',
    task: 'odd-one-out (3 versions, 1 altered), 2-down/1-up staircase on the removal offset',
    earScoreMapping: 'score = clamp(50 - 2.5 * thresholdDb, 0, 100)',
    ...result,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  download(blob, `masked-results-${result.finishedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
});

$('#studio-choose').addEventListener('click', () => pickFile('studio'));
$('#studio-demo').addEventListener('click', () => loadDemo('studio'));
$('#studio-back').addEventListener('click', () => show(game?.lastResult ? 'score' : 'home'));
$('#cancel-analysis').addEventListener('click', () => job?.cancel());
$('#retry-analysis').addEventListener('click', () => void runAnalysis(Number(offsetInput.value)));
reanalyzeButton.addEventListener('click', () => void runAnalysis(Number(offsetInput.value)));
offsetInput.addEventListener('input', () => {
  const value = Number(offsetInput.value);
  offsetValue.textContent = `${value > 0 ? '+' : ''}${value} dB`;
});

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
function reloadStudioPlayer(): void {
  if (!song || !studioPlayer) return;
  const p = studioPlayer;
  const position = p.position();
  const wasPlaying = p.active !== null;
  const sources: Record<string, AudioBuffer> = { original: song.buffer };
  if (analysis) sources.processed = analysis.processed;
  p.load(sources, versionMixes(), analysis?.headroom ?? song.headroom);
  if (!analysis) selected = 'original';
  if (wasPlaying && position !== null) {
    p.play(selected, position);
    animate();
  }
  updateTransport();
}

function updateTransport(): void {
  const playing = studioPlayer?.active ?? null;
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
  const position = studioPlayer?.position() ?? null;
  map.setPlayhead(position);
  waveform.setPlayhead(position);
  if (position !== null) {
    updateTime(position);
    requestAnimationFrame(animate);
  }
}

function togglePlay(): void {
  if (!song || !studioPlayer) return;
  const p = studioPlayer;
  if (p.active) {
    pausedAt = p.position() ?? 0;
    p.stop();
    return;
  }
  p.play(selected, pausedAt);
  animate();
}

function seekTo(seconds: number): void {
  if (!song || !studioPlayer) return;
  const wasPlaying = studioPlayer.active !== null;
  pausedAt = seconds;
  studioPlayer.seek(seconds, selected);
  if (!wasPlaying) animate();
}

playToggle.addEventListener('click', togglePlay);

for (const button of versionButtons) {
  button.addEventListener('click', () => {
    selected = button.dataset.play as Version;
    // While playing this crossfades at the current position; while stopped
    // it just chooses what Play will start.
    if (studioPlayer?.active) studioPlayer.play(selected);
    updateTransport();
  });
}

boostInput.addEventListener('change', () => {
  const mix = versionMixes().removed;
  if (mix) studioPlayer?.setMix('removed', mix);
});

document.addEventListener('keydown', (e) => {
  // Space toggles playback in Studio mode, unless a control has focus
  // (where Space already means "press this").
  if (e.key !== ' ' || currentScreen !== 'studio') return;
  const target = e.target as HTMLElement;
  if (target.closest('button, input, select, textarea, summary, label')) return;
  e.preventDefault();
  togglePlay();
});

const map = new MaskingMapView($<HTMLCanvasElement>('#masking-map'), seekTo);

const waveform = new WaveformView($<HTMLCanvasElement>('#waveform'), () => {
  // Dragging means the producer is choosing their own passage.
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
  waveform.setRegion(bestPassage(baseline.removedEnergy, baseline.frameSeconds, length, song.buffer.duration), length);
  updateRegionLabel();
}

function updateRegionLabel(): void {
  const start = waveform.regionStart;
  const range = `${formatTime(start)} to ${formatTime(start + waveform.regionDuration)}`;
  if (passageMode === 'manual') regionLabel.textContent = `${range}. Drag it, or tap where you want it.`;
  else if (baseline) regionLabel.textContent = `${range}: where the standard model removes the most. Drag to choose your own.`;
  else regionLabel.textContent = 'Picked automatically once the analysis finishes.';
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

studioTest.addEventListener('click', () => {
  const current = song;
  if (!current) return;
  const region = regionFrom(current, waveform.regionStart, waveform.regionDuration);
  ensureGame().begin({
    name: current.name,
    buffer: current.buffer,
    headroom: current.headroom,
    region: Promise.resolve(region),
    progress: () => 1,
  });
});

// ---- Start-up ----------------------------------------------------------------------------

new LiveWave($<HTMLCanvasElement>('#home-wave'), { bars: 36, idle: 0.42 });
new LiveWave($<HTMLCanvasElement>('#volume-wave'), { bars: 32, idle: 0.12 });
new LiveWave($<HTMLCanvasElement>('#studio-wave'), { bars: 56, idle: 0.06 });

passageLength.value = String(REGION_SECONDS);
passageLengthValue.textContent = `${REGION_SECONDS} s`;
setHomeBusy(false);
if (DEMO_TRACK) {
  homeNote.textContent = 'Uses a short built-in song. Headphones needed.';
} else {
  ownSong.hidden = true;
  homeNote.textContent = 'Any song file from your phone or computer works. It stays on your device. Headphones needed.';
}
show('home');
if (!hasWebAudio(window as MaybeAudioGlobals)) {
  startMain.disabled = true;
  homeError.hidden = false;
  homeError.textContent = "This browser can't play the test. Try a recent Chrome, Safari, Firefox or Edge.";
}
