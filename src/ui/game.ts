import { channelsToBuffer } from '../audio/load';
import { RegionPlayer } from '../audio/player';
import { SyncedPlayer, type Mix } from '../audio/synced-player';
import {
  correctToneIndex,
  HEADPHONE_TRIALS,
  headphoneCheckPassed,
  randomToneOrder,
  renderHeadphoneTrial,
  type ToneRole,
} from '../check/headphones';
import type { EngineClient } from '../engine/client';
import { PEAK_CEILING, samplePeak } from '../engine/loudness';
import { earScore, scoreSentence, takeaway } from '../quiz/ear-score';
import { scoreTrials, type QuizScore } from '../quiz/scoring';
import { Staircase, type ThresholdEstimate } from '../quiz/staircase';
import { confetti, countUp } from './celebrate';
import { addHistory } from './history';
import { LiveWave } from './live-wave';
import { renderResultCard } from './result-card';

/** The passage under test. Channels already have their loop-edge fades. */
export interface TestRegion {
  songName: string;
  startSeconds: number;
  durationSeconds: number;
  sampleRate: number;
  channels: Float32Array[];
}

export interface GameSong {
  name: string;
  /** The whole song, for the volume step. */
  buffer: AudioBuffer;
  headroom: number;
  /** Resolves once the song is analysed and the passage picked. */
  region: Promise<TestRegion>;
  /** How far the preparation has got, 0 to 1, for the "almost ready" bar. */
  progress: () => number;
}

export interface TrialRecord {
  question: number;
  offsetDb: number;
  /** Which card (0-2) held the altered version. */
  oddIndex: number;
  answerIndex: number;
  correct: boolean;
  reversal: boolean;
  responseMs: number;
  listens: number;
  loudnessGainDb: number;
}

export interface HeadphoneRecord {
  order: ToneRole[];
  answerIndex: number;
  correct: boolean;
}

/** Everything about the last finished test, for Studio mode. */
export interface GameResult {
  songName: string;
  region: { startSeconds: number; durationSeconds: number; sampleRate: number };
  startedAt: Date;
  finishedAt: Date;
  estimate: ThresholdEstimate;
  earScore: number;
  score: QuizScore;
  headphones: { correct: number; passed: boolean; trials: HeadphoneRecord[] } | null;
  staircase: { config: Staircase['config']; reversals: number[] };
  trials: TrialRecord[];
}

export type Screen = 'volume' | 'tones' | 'test' | 'score';

interface TrialAudio {
  processed: AudioBuffer;
  headroom: number;
  gainDb: number;
}

interface Question {
  offsetDb: number;
  oddIndex: number;
  audio: TrialAudio;
  shownAt: number;
  heard: Set<number>;
  selected: number | null;
  listens: number;
}

export interface GameDeps {
  context: AudioContext;
  engine: EngineClient;
  /** The app's output (an analyser in front of the speakers). */
  output: AudioNode;
  show: (screen: Screen) => void;
  onQuit: () => void;
  onOwnSong: () => void;
}

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Masked: ${selector} not found in index.html`);
  return el;
}

/**
 * The main flow: set the volume, check for headphones, the odd-one-out test,
 * and the Ear Score. All wording here is everyday language on purpose.
 */
export class Game {
  private readonly player: SyncedPlayer;
  private readonly tonePlayer: RegionPlayer;

  private readonly volumePlay = $<HTMLButtonElement>('#volume-play');
  private readonly tonesDots = $<HTMLElement>('#tones-dots');
  private readonly tonesPlay = $<HTMLButtonElement>('#tones-play');
  private readonly tonesChoices = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-hp]'));
  private readonly tonesResult = $<HTMLElement>('#tones-result');
  private readonly tonesResultText = $<HTMLElement>('#tones-result-text');
  private readonly tonesRetry = $<HTMLButtonElement>('#tones-retry');
  private readonly tonesContinue = $<HTMLButtonElement>('#tones-continue');
  private readonly questionLabel = $<HTMLElement>('#question-label');
  private readonly questionFill = $<HTMLElement>('#question-fill');
  private readonly testWait = $<HTMLElement>('#test-wait');
  private readonly waitFill = $<HTMLElement>('#wait-fill');
  private readonly waitText = $<HTMLElement>('#wait-text');
  private readonly testMain = $<HTMLElement>('#test-main');
  private readonly testHint = $<HTMLElement>('#test-hint');
  private readonly cards = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-card]'));
  private readonly cardWaves: LiveWave[];
  private readonly submit = $<HTMLButtonElement>('#test-submit');

  private song: GameSong | null = null;
  private region: TestRegion | null = null;
  private original: AudioBuffer | null = null;
  private originalHeadroom = 1;
  private cache = new Map<number, Promise<TrialAudio>>();
  private staircase = new Staircase();
  private records: TrialRecord[] = [];
  private question: Question | null = null;
  private startedAt = new Date();
  /** Kept for the whole visit: a new song does not need a new headphone check. */
  private headphones: GameResult['headphones'] = null;
  private toneOrders: ToneRole[][] = [];
  private toneRecords: HeadphoneRecord[] = [];
  private tonesPlayed = false;
  /** Bumped whenever a new song or test starts, so stale async work is ignored. */
  private token = 0;
  private screen: Screen | null = null;
  lastResult: GameResult | null = null;

  constructor(private readonly deps: GameDeps) {
    this.player = new SyncedPlayer(deps.context, () => this.refresh(), deps.output);
    this.tonePlayer = new RegionPlayer(deps.context, () => this.onTonesEnded(), deps.output);
    this.cardWaves = this.cards.map((card) => {
      const canvas = card.querySelector('canvas');
      if (!canvas) throw new Error('Masked: sound card without a canvas');
      return new LiveWave(canvas, { bars: 14, idle: 0.08 });
    });

    this.volumePlay.addEventListener('click', () => this.toggleVolumeMusic());
    $('#volume-done').addEventListener('click', () => this.afterVolume());
    this.tonesPlay.addEventListener('click', () => this.playTones());
    this.tonesChoices.forEach((b) => b.addEventListener('click', () => this.answerTones(Number(b.dataset.hp))));
    this.tonesRetry.addEventListener('click', () => this.startTones());
    this.tonesContinue.addEventListener('click', () => void this.startTest());
    this.cards.forEach((card, i) => card.addEventListener('click', () => this.listen(i)));
    this.submit.addEventListener('click', () => this.answer());
    $('#test-quit').addEventListener('click', () => this.quit());
    $('#score-retake').addEventListener('click', () => this.retake());
    $('#score-own').addEventListener('click', () => {
      this.stopAll();
      this.deps.onOwnSong();
    });
    $('#score-share').addEventListener('click', () => void this.share());
    document.addEventListener('keydown', (e) => this.handleKey(e));
  }

  get isActive(): boolean {
    return this.screen !== null && this.screen !== 'score';
  }

  /** Starts the flow for a song: volume first, then (once per visit) the headphone check. */
  begin(song: GameSong): void {
    this.stopAll();
    this.token++;
    this.song = song;
    this.region = null;
    this.original = null;
    this.cache = new Map();
    const token = this.token;
    song.region.then(
      (region) => {
        if (token !== this.token) return;
        this.region = region;
        this.original = channelsToBuffer(this.deps.context, region.channels, region.sampleRate);
        this.originalHeadroom = Math.min(1, PEAK_CEILING / Math.max(samplePeak(region.channels), 1e-9));
        // Start on the first question's audio straight away, so it is ready
        // by the time the headphone check is done.
        void this.request(new Staircase().currentOffset).catch(() => {});
      },
      () => {
        // Reported when the test screen waits for it.
      },
    );
    this.player.load({ song: song.buffer }, { song: { song: 1 } }, song.headroom);
    this.go('volume');
  }

  private go(screen: Screen): void {
    this.screen = screen;
    this.deps.show(screen);
    this.refresh();
  }

  private stopAll(): void {
    this.player.stop();
    this.tonePlayer.stop();
  }

  private quit(): void {
    this.stopAll();
    this.token++;
    this.screen = null;
    this.deps.onQuit();
  }

  private refresh(): void {
    const playing = this.player.active !== null;
    if (this.screen === 'volume') {
      this.volumePlay.classList.toggle('is-playing', playing);
      this.volumePlay.setAttribute('aria-label', playing ? 'Stop the music' : 'Play the music');
    }
    const selected = this.question?.selected ?? null;
    this.cards.forEach((card, i) => {
      const on = playing && selected === i;
      card.classList.toggle('is-playing', on);
      card.classList.toggle('is-heard', this.question?.heard.has(i) ?? false);
      card.setAttribute('aria-pressed', String(on));
      const wave = this.cardWaves[i];
      if (wave) wave.live = on;
    });
  }

  // ---- Volume -------------------------------------------------------------

  private toggleVolumeMusic(): void {
    if (this.player.active) this.player.stop();
    // A third of the way in is usually past any quiet intro.
    else this.player.play('song', (this.song?.buffer.duration ?? 0) / 3);
  }

  private afterVolume(): void {
    this.player.stop();
    if (this.headphones?.passed) void this.startTest();
    else this.startTones();
  }

  // ---- Headphone check ---------------------------------------------------

  private startTones(): void {
    this.toneOrders = Array.from({ length: HEADPHONE_TRIALS }, () => randomToneOrder());
    this.toneRecords = [];
    this.tonesResult.hidden = true;
    this.tonesPlay.hidden = false;
    this.tonesChoices.forEach((b) => (b.hidden = false));
    this.go('tones');
    this.showToneRound();
  }

  private showToneRound(): void {
    const round = this.toneRecords.length;
    this.tonesPlayed = false;
    this.tonesPlay.disabled = false;
    this.tonesPlay.textContent = round === 0 ? 'Play the hums' : 'Play the next hums';
    this.tonesChoices.forEach((b) => (b.disabled = true));
    this.tonesDots.replaceChildren(
      ...Array.from({ length: HEADPHONE_TRIALS }, (_, i) => {
        const dot = document.createElement('i');
        if (i < round) dot.className = 'is-done';
        else if (i === round) dot.className = 'is-current';
        return dot;
      }),
    );
  }

  private playTones(): void {
    const order = this.toneOrders[this.toneRecords.length];
    if (!order) return;
    const rate = this.deps.context.sampleRate;
    this.tonesPlayed = true;
    // One play per round, as in the original procedure (Woods et al. 2017).
    this.tonesPlay.disabled = true;
    this.tonePlayer.play(channelsToBuffer(this.deps.context, renderHeadphoneTrial(order, rate), rate));
  }

  private onTonesEnded(): void {
    if (this.screen === 'tones' && this.tonesPlayed) this.tonesChoices.forEach((b) => (b.disabled = false));
  }

  private answerTones(index: number): void {
    const order = this.toneOrders[this.toneRecords.length];
    if (!order) return;
    this.toneRecords.push({ order, answerIndex: index, correct: index === correctToneIndex(order) });
    if (this.toneRecords.length < HEADPHONE_TRIALS) {
      this.showToneRound();
      return;
    }
    const correct = this.toneRecords.filter((r) => r.correct).length;
    const passed = headphoneCheckPassed(correct);
    this.headphones = { correct, passed, trials: this.toneRecords };
    this.tonesPlay.hidden = true;
    this.tonesChoices.forEach((b) => (b.hidden = true));
    this.tonesDots.replaceChildren();
    this.tonesResult.hidden = false;
    this.tonesResult.classList.toggle('is-warning', !passed);
    this.tonesRetry.hidden = passed;
    if (passed) {
      this.tonesResultText.textContent = "Perfect. You're on headphones.";
      this.tonesContinue.textContent = 'Start the test';
    } else {
      this.tonesResultText.textContent =
        "Hmm, that sounded like speakers, or one side isn't working. The test works best with headphones.";
      this.tonesContinue.textContent = 'Continue anyway';
    }
  }

  // ---- The test ------------------------------------------------------------

  /** Processed audio for one level, computed once while it may still be needed. */
  private request(offsetDb: number): Promise<TrialAudio> {
    const region = this.region;
    if (!region) return Promise.reject(new Error('The song is not ready yet.'));
    let pending = this.cache.get(offsetDb);
    if (!pending) {
      const { channels, sampleRate } = region;
      // Copies, because the worker takes ownership of what it is sent.
      pending = this.deps.engine
        .process(channels.map((c) => c.slice()), sampleRate, offsetDb)
        .then((r) => ({
          processed: channelsToBuffer(this.deps.context, r.processed, sampleRate),
          headroom: Math.min(r.loudness.headroom, this.originalHeadroom),
          gainDb: r.loudness.gainDb,
        }));
      // A failure is dropped from the cache, so asking again retries.
      pending.catch(() => this.cache.delete(offsetDb));
      this.cache.set(offsetDb, pending);
    }
    return pending;
  }

  private async startTest(): Promise<void> {
    this.stopAll();
    this.staircase = new Staircase();
    this.records = [];
    this.startedAt = new Date();
    this.go('test');
    const token = this.token;

    if (!this.region && this.song) {
      // Still analysing the song: show a friendly progress bar until it is ready.
      this.testWait.hidden = false;
      this.testMain.hidden = true;
      this.waitText.textContent = 'Getting your song ready...';
      const song = this.song;
      const timer = window.setInterval(() => {
        this.waitFill.style.width = `${Math.round(song.progress() * 100)}%`;
      }, 150);
      try {
        await song.region;
      } catch {
        this.waitText.textContent = "Sorry, that song didn't work. Try a different one.";
        window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      // The region handler in begin() runs first, so this.region is set now.
      if (token !== this.token) return;
    }
    this.testWait.hidden = true;
    this.testMain.hidden = false;
    void this.loadQuestion();
  }

  private retake(): void {
    if (!this.region) return;
    this.token++;
    void this.startTest();
  }

  private async loadQuestion(): Promise<void> {
    const original = this.original;
    if (!original) return;
    const token = this.token;
    const staircase = this.staircase;
    const offset = staircase.currentOffset;
    const number = this.records.length + 1;
    this.questionLabel.textContent = `Question ${number}`;
    // The staircase usually stops on direction changes before the question
    // limit, so the bar follows whichever limit is closer to being reached.
    const done = Math.max(
      this.records.length / staircase.config.maxTrials,
      staircase.reversals.length / staircase.config.maxReversals,
    );
    this.questionFill.style.width = `${Math.max(4, Math.round(100 * done))}%`;
    this.setCardsEnabled(false);
    this.submit.disabled = true;
    this.submit.textContent = 'Pick one';
    this.testHint.textContent = 'Getting the next one ready...';

    let audio: TrialAudio;
    try {
      audio = await this.request(offset);
    } catch {
      if (token === this.token) this.testHint.textContent = 'Something went wrong. Quit and try again.';
      return;
    }
    if (token !== this.token) return;

    // Precompute both possible next levels while the user listens, so the
    // next question can start straight away whichever answer they give.
    const next = [staircase.peekNext(true), staircase.peekNext(false)];
    for (const key of this.cache.keys()) if (key !== offset && !next.includes(key)) this.cache.delete(key);
    for (const o of next) void this.request(o).catch(() => {});

    // Two cards play the original, one plays the altered version, at a
    // random position every question.
    const oddIndex = Math.floor(Math.random() * 3);
    const versions: Record<string, Mix> = {};
    for (let i = 0; i < 3; i++) versions[`card${i}`] = i === oddIndex ? { processed: 1 } : { original: 1 };
    this.player.load({ original, processed: audio.processed }, versions, audio.headroom);
    this.question = { offsetDb: offset, oddIndex, audio, shownAt: performance.now(), heard: new Set(), selected: null, listens: 0 };

    // Replay the entrance animation on the cards for each new question.
    for (const card of this.cards) {
      card.classList.remove('enter');
      void card.offsetWidth;
      card.classList.add('enter');
    }
    this.setCardsEnabled(true);
    this.testHint.textContent = 'Tap each one to listen. Switch as often as you like.';
    this.refresh();
  }

  private setCardsEnabled(enabled: boolean): void {
    this.cards.forEach((c) => (c.disabled = !enabled));
  }

  private listen(index: number): void {
    const q = this.question;
    if (!q) return;
    // All three cards share one looping timeline, so switching keeps the
    // same moment of music and only the version changes.
    this.player.play(`card${index}`);
    q.selected = index;
    q.heard.add(index);
    q.listens++;
    if (q.heard.size === 3) {
      this.submit.disabled = false;
      this.submit.textContent = `Number ${index + 1} sounds different`;
      this.testHint.textContent = 'Found it? Play the different one, then tap the button.';
    } else {
      this.testHint.textContent = `Now listen to the other ${3 - q.heard.size === 1 ? 'one' : 'two'}.`;
    }
    this.refresh();
  }

  private answer(): void {
    const q = this.question;
    if (!q || q.selected === null || q.heard.size < 3) return;
    const correct = q.selected === q.oddIndex;
    this.staircase.record(correct);
    const last = this.staircase.trials[this.staircase.trials.length - 1];
    this.records.push({
      question: this.records.length + 1,
      offsetDb: q.offsetDb,
      oddIndex: q.oddIndex,
      answerIndex: q.selected,
      correct,
      reversal: last?.reversal ?? false,
      responseMs: Math.round(performance.now() - q.shownAt),
      listens: q.listens,
      loudnessGainDb: q.audio.gainDb,
    });
    this.question = null;
    this.player.stop();
    // No right/wrong feedback: it would reveal which version is which.
    if (this.staircase.isFinished) this.showScore();
    else void this.loadQuestion();
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.screen !== 'test' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      if (this.cards[0]?.disabled) return;
      this.listen(Number(e.key) - 1);
    } else if (e.key === 'Enter') {
      if (this.submit.disabled) return;
      this.answer();
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- Score --------------------------------------------------------------

  private showScore(): void {
    const region = this.region;
    if (!region) return;
    const estimate = this.staircase.threshold();
    const score = earScore(estimate.thresholdDb);
    this.lastResult = {
      songName: region.songName,
      region: { startSeconds: region.startSeconds, durationSeconds: region.durationSeconds, sampleRate: region.sampleRate },
      startedAt: this.startedAt,
      finishedAt: new Date(),
      estimate,
      earScore: score,
      score: scoreTrials(this.records),
      headphones: this.headphones,
      staircase: { config: this.staircase.config, reversals: [...this.staircase.reversals] },
      trials: this.records,
    };
    addHistory({
      at: new Date().toISOString(),
      thresholdDb: estimate.thresholdDb,
      reliable: estimate.reliable,
      headphonesPassed: this.headphones?.passed ?? false,
      passageSeconds: Math.round(region.durationSeconds),
      song: region.songName,
    });

    $('#score-sentence').textContent = scoreSentence(score);
    $('#score-takeaway').textContent = takeaway(score);
    const caveats: string[] = [];
    if (!estimate.reliable) caveats.push('Your answers went up and down a lot, so this is a rough score. A retake can sharpen it.');
    if (!this.headphones?.passed) caveats.push('You may have been on speakers, so your real score could be higher.');
    const caveat = $('#score-caveat');
    caveat.hidden = caveats.length === 0;
    caveat.textContent = caveats.join(' ');

    this.go('score');
    const value = $('#score-value');
    const ring = document.querySelector<SVGCircleElement>('#score-ring-fill');
    countUp(score, 1400, (v) => {
      value.textContent = String(v);
      // The ring's dash length is its circumference (2 * pi * 52, about 327).
      ring?.style.setProperty('stroke-dashoffset', String(327 * (1 - v / 100)));
    });
    confetti();
  }

  /** Saves the score card as a PNG, through the share sheet where available (phones). */
  private async share(): Promise<void> {
    const result = this.lastResult;
    if (!result) return;
    const blob = await renderResultCard({
      score: result.earScore,
      sentence: scoreSentence(result.earScore),
      takeaway: takeaway(result.earScore),
      date: result.finishedAt,
    });
    const file = new File([blob], 'my-ear-score.png', { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Ear Score' });
        return;
      }
    } catch (error) {
      // Closing the share sheet is not an error worth reporting.
      if ((error as Error).name === 'AbortError') return;
    }
    download(blob, file.name);
  }
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked later: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
