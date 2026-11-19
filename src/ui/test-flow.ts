import { channelsToBuffer } from '../audio/load';
import { RegionPlayer } from '../audio/player';
import { SyncedPlayer } from '../audio/synced-player';
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
import { interpretThreshold, scoreTrials } from '../quiz/scoring';
import { Staircase } from '../quiz/staircase';
import { addHistory, type HistoryEntry } from './history';
import { renderResultCard } from './result-card';
import { renderStaircaseChart } from './staircase-chart';

/** Why the user came: changes the wording around the result, not the test. */
export type Intent = 'lossless' | 'wasted' | 'fatigue';

/** The section under test. Channels already have their loop-edge fades. */
export interface TestRegion {
  songName: string;
  startSeconds: number;
  durationSeconds: number;
  sampleRate: number;
  channels: Float32Array[];
  intent: Intent;
}

interface TrialAudio {
  processed: AudioBuffer;
  headroom: number;
  gainDb: number;
}

interface QuizTrialRecord {
  trial: number;
  offsetDb: number;
  aIs: 'original' | 'processed';
  xIs: 'A' | 'B';
  answer: 'A' | 'B';
  correct: boolean;
  reversal: boolean;
  responseMs: number;
  switches: number;
  loudnessGainDb: number;
}

interface HeadphoneRecord {
  order: ToneRole[];
  answerIndex: number;
  correct: boolean;
}

interface CurrentTrial {
  offsetDb: number;
  aIsOriginal: boolean;
  xIsA: boolean;
  audio: TrialAudio;
  shownAt: number;
  switches: number;
  heardX: boolean;
}

interface Session {
  region: TestRegion;
  original: AudioBuffer;
  originalHeadroom: number;
  cache: Map<number, Promise<TrialAudio>>;
  staircase: Staircase;
  headphoneOrders: ToneRole[][];
  headphoneRecords: HeadphoneRecord[];
  tonesPlayed: boolean;
  current: CurrentTrial | null;
  records: QuizTrialRecord[];
  startedAt: Date;
}

export type Step = 'volume' | 'headphones' | 'quiz' | 'results';
type AbxKey = 'A' | 'B' | 'X';

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Masked: ${selector} not found in index.html`);
  return el;
}

/** Drives the listening test: volume, headphone check, ABX staircase, results. */
export class TestFlow {
  private readonly section = $<HTMLElement>('#test');
  private readonly steps: Record<Step, HTMLElement> = {
    volume: $('#step-volume'),
    headphones: $('#step-headphones'),
    quiz: $('#step-quiz'),
    results: $('#step-results'),
  };
  private readonly volumePlay = $<HTMLButtonElement>('#volume-play');
  private readonly hpProgress = $<HTMLElement>('#hp-progress');
  private readonly hpPlay = $<HTMLButtonElement>('#hp-play');
  private readonly hpAnswers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-hp]'));
  private readonly hpResult = $<HTMLElement>('#hp-result');
  private readonly hpContinue = $<HTMLButtonElement>('#hp-continue');
  private readonly quizProgress = $<HTMLElement>('#quiz-progress');
  private readonly quizStatus = $<HTMLElement>('#quiz-status');
  private readonly abxButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-abx]'));
  private readonly answerA = $<HTMLButtonElement>('#answer-a');
  private readonly answerB = $<HTMLButtonElement>('#answer-b');
  private readonly hpDots = $<HTMLElement>('#hp-dots');
  private readonly quizFill = $<HTMLElement>('#quiz-fill');
  private readonly exitButton = $<HTMLButtonElement>('#test-exit');

  private readonly player: SyncedPlayer;
  private readonly tonePlayer: RegionPlayer;
  private session: Session | null = null;
  private step: Step | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly engine: EngineClient,
    private readonly onExit: () => void,
    private readonly onStepChange: (step: Step) => void,
  ) {
    this.player = new SyncedPlayer(context, () => this.refreshButtons());
    this.tonePlayer = new RegionPlayer(context, () => this.onTonesEnded());

    this.volumePlay.addEventListener('click', () => this.toggleReference());
    $('#volume-done').addEventListener('click', () => this.startHeadphoneCheck());
    this.hpPlay.addEventListener('click', () => this.playTones());
    this.hpAnswers.forEach((b) => b.addEventListener('click', () => this.answerHeadphones(Number(b.dataset.hp))));
    this.hpContinue.addEventListener('click', () => this.startQuiz());
    this.abxButtons.forEach((b) => b.addEventListener('click', () => this.listen(b.dataset.abx as AbxKey)));
    this.answerA.addEventListener('click', () => this.answer('A'));
    this.answerB.addEventListener('click', () => this.answer('B'));
    $('#export-json').addEventListener('click', () => this.exportJson());
    $('#results-back').addEventListener('click', () => this.exit());
    $('#results-retest').addEventListener('click', () => this.retest());
    $('#share-card').addEventListener('click', () => void this.shareCard());
    this.exitButton.addEventListener('click', () => this.exit());
    document.addEventListener('keydown', (e) => this.handleKey(e));
  }

  get isActive(): boolean {
    return this.session !== null;
  }

  begin(region: TestRegion): void {
    const original = channelsToBuffer(this.context, region.channels, region.sampleRate);
    this.session = {
      region,
      original,
      originalHeadroom: Math.min(1, PEAK_CEILING / Math.max(samplePeak(region.channels), 1e-9)),
      cache: new Map(),
      staircase: new Staircase(),
      headphoneOrders: Array.from({ length: HEADPHONE_TRIALS }, () => randomToneOrder()),
      headphoneRecords: [],
      tonesPlayed: false,
      current: null,
      records: [],
      startedAt: new Date(),
    };
    // Start processing the first trial now, so it is ready by the time the
    // volume and headphone steps are done.
    void this.request(this.session.staircase.currentOffset);
    this.section.hidden = false;
    this.show('volume');
  }

  private show(step: Step): void {
    this.step = step;
    for (const [name, el] of Object.entries(this.steps)) el.hidden = name !== step;
    // On the results there is nothing left to exit; it has its own buttons.
    this.exitButton.hidden = step === 'results';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.refreshButtons();
    this.onStepChange(step);
  }

  /** Same passage again, with a fresh staircase and headphone check. */
  private retest(): void {
    const s = this.session;
    if (!s) return;
    this.player.stop();
    this.begin(s.region);
  }

  private exit(): void {
    this.player.stop();
    this.tonePlayer.stop();
    this.session = null;
    this.step = null;
    this.section.hidden = true;
    this.onExit();
  }

  private refreshButtons(): void {
    this.volumePlay.setAttribute('aria-pressed', String(this.step === 'volume' && this.player.active !== null));
    this.volumePlay.textContent = this.player.active && this.step === 'volume' ? 'Stop reference' : 'Play reference';
    for (const b of this.abxButtons) b.setAttribute('aria-pressed', String(b.dataset.abx === this.player.active));
  }

  // ---- Audio for each offset -------------------------------------------

  /** Processed audio for one offset, computed once and cached while it may be needed. */
  private request(offsetDb: number): Promise<TrialAudio> {
    const s = this.session;
    if (!s) return Promise.reject(new Error('No test in progress.'));
    let pending = s.cache.get(offsetDb);
    if (!pending) {
      const { channels, sampleRate } = s.region;
      // Copies, because the worker takes ownership of what it is sent.
      pending = this.engine.process(channels.map((c) => c.slice()), sampleRate, offsetDb).then((r) => ({
        processed: channelsToBuffer(this.context, r.processed, sampleRate),
        headroom: r.loudness.headroom,
        gainDb: r.loudness.gainDb,
      }));
      // A failure is dropped from the cache, so asking again retries.
      pending.catch(() => s.cache.delete(offsetDb));
      s.cache.set(offsetDb, pending);
    }
    return pending;
  }

  /** Keeps only the offsets that could still be needed, to bound memory on phones. */
  private pruneCache(keep: readonly number[]): void {
    const s = this.session;
    if (!s) return;
    for (const offset of s.cache.keys()) if (!keep.includes(offset)) s.cache.delete(offset);
  }

  // ---- Step 1: volume --------------------------------------------------

  private toggleReference(): void {
    const s = this.session;
    if (!s) return;
    if (this.player.active) {
      this.player.stop();
      return;
    }
    this.player.load({ original: s.original }, { original: { original: 1 } }, s.originalHeadroom);
    this.player.play('original');
  }

  // ---- Step 2: headphone check -----------------------------------------

  private startHeadphoneCheck(): void {
    this.player.stop();
    this.show('headphones');
    this.hpResult.textContent = '';
    this.hpResult.classList.remove('warning');
    this.hpContinue.hidden = true;
    this.hpPlay.hidden = false;
    this.hpAnswers.forEach((b) => (b.hidden = false));
    this.showHeadphoneRound();
  }

  private showHeadphoneRound(): void {
    const s = this.session;
    if (!s) return;
    s.tonesPlayed = false;
    const round = s.headphoneRecords.length;
    this.hpProgress.textContent = `Round ${round + 1} of ${HEADPHONE_TRIALS}`;
    this.hpDots.replaceChildren(
      ...Array.from({ length: HEADPHONE_TRIALS }, (_, i) => {
        const dot = document.createElement('i');
        if (i < round) dot.className = 'is-done';
        else if (i === round) dot.className = 'is-current';
        return dot;
      }),
    );
    this.hpPlay.disabled = false;
    this.hpAnswers.forEach((b) => (b.disabled = true));
  }

  private playTones(): void {
    const s = this.session;
    if (!s) return;
    const order = s.headphoneOrders[s.headphoneRecords.length];
    if (!order) return;
    const rate = this.context.sampleRate;
    s.tonesPlayed = true;
    // One play per round, as in the original procedure: a replay would let
    // listeners compare more carefully than the test is calibrated for.
    this.hpPlay.disabled = true;
    this.tonePlayer.play(channelsToBuffer(this.context, renderHeadphoneTrial(order, rate), rate));
  }

  private onTonesEnded(): void {
    if (this.step === 'headphones' && this.session?.tonesPlayed) this.hpAnswers.forEach((b) => (b.disabled = false));
  }

  private answerHeadphones(index: number): void {
    const s = this.session;
    if (!s) return;
    const order = s.headphoneOrders[s.headphoneRecords.length];
    if (!order) return;
    s.headphoneRecords.push({ order, answerIndex: index, correct: index === correctToneIndex(order) });
    if (s.headphoneRecords.length < HEADPHONE_TRIALS) {
      this.showHeadphoneRound();
      return;
    }

    const correct = s.headphoneRecords.filter((r) => r.correct).length;
    this.hpPlay.hidden = true;
    this.hpAnswers.forEach((b) => (b.hidden = true));
    this.hpProgress.textContent = '';
    this.hpDots.replaceChildren();
    if (headphoneCheckPassed(correct)) {
      this.hpResult.textContent = `Headphones confirmed: ${correct} of ${HEADPHONE_TRIALS} correct.`;
    } else {
      this.hpResult.classList.add('warning');
      this.hpResult.textContent =
        `You found the quietest tone in ${correct} of ${HEADPHONE_TRIALS} rounds (5 needed). This usually means ` +
        'the sound is coming from speakers rather than headphones, or one side is not working. You can ' +
        'continue, but your result will be marked as not headphone-verified.';
    }
    this.hpContinue.hidden = false;
  }

  // ---- Step 3: ABX quiz ------------------------------------------------

  private startQuiz(): void {
    this.show('quiz');
    void this.loadTrial();
  }

  private setQuizButtons(listen: boolean, answer: boolean): void {
    this.abxButtons.forEach((b) => (b.disabled = !listen));
    this.answerA.disabled = !answer;
    this.answerB.disabled = !answer;
  }

  private async loadTrial(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const staircase = s.staircase;
    const offset = staircase.currentOffset;
    this.setQuizButtons(false, false);
    this.quizProgress.textContent = `Trial ${s.records.length + 1} · at most ${staircase.config.maxTrials}`;
    // The staircase usually stops on reversals before the trial limit, so the
    // bar shows whichever limit is closer to being reached.
    const done = Math.max(
      s.records.length / staircase.config.maxTrials,
      staircase.reversals.length / staircase.config.maxReversals,
    );
    this.quizFill.style.width = `${Math.round(100 * done)}%`;
    this.quizStatus.textContent = 'Preparing this trial...';

    let audio: TrialAudio;
    try {
      audio = await this.request(offset);
    } catch (error) {
      if (this.session === s) {
        this.quizStatus.textContent = `Processing failed: ${(error as Error).message}. Exit and try again.`;
      }
      return;
    }
    // The user may have exited while we waited.
    if (this.session !== s) return;

    // Precompute both possible next offsets while the user listens, so the
    // next trial can start straight away whichever answer they give.
    const next = [staircase.peekNext(true), staircase.peekNext(false)];
    this.pruneCache([offset, ...next]);
    for (const o of next) void this.request(o).catch(() => {});

    // Fresh random assignment every trial: which of A/B is the original, and
    // which of them X is. Nothing about position can be learned over trials.
    const aIsOriginal = Math.random() < 0.5;
    const xIsA = Math.random() < 0.5;
    const original = { original: 1 };
    const processed = { processed: 1 };
    const a = aIsOriginal ? original : processed;
    const b = aIsOriginal ? processed : original;
    // X is a mix of the same two sources. Switching from A to an X that equals
    // A changes no gain at all, and with linear crossfades that is exactly
    // what a fade between two identical, sample-locked copies would sound
    // like too, so nothing about the switch itself gives the answer away.
    this.player.load(
      { original: s.original, processed: audio.processed },
      { A: a, B: b, X: xIsA ? a : b },
      audio.headroom,
    );

    s.current = { offsetDb: offset, aIsOriginal, xIsA, audio, shownAt: performance.now(), switches: 0, heardX: false };
    this.setQuizButtons(true, false);
    this.quizStatus.textContent = 'Press A, B or X to start listening. You can answer once you have heard X.';
  }

  private listen(key: AbxKey): void {
    const trial = this.session?.current;
    if (!trial) return;
    this.player.play(key);
    trial.switches++;
    if (key === 'X' && !trial.heardX) {
      trial.heardX = true;
      this.setQuizButtons(true, true);
    }
    this.quizStatus.textContent = `Playing ${key}.`;
  }

  private answer(choice: 'A' | 'B'): void {
    const s = this.session;
    const trial = s?.current;
    if (!s || !trial || !trial.heardX) return;
    const correct = (choice === 'A') === trial.xIsA;
    s.staircase.record(correct);
    const last = s.staircase.trials[s.staircase.trials.length - 1];
    s.records.push({
      trial: s.records.length + 1,
      offsetDb: trial.offsetDb,
      aIs: trial.aIsOriginal ? 'original' : 'processed',
      xIs: trial.xIsA ? 'A' : 'B',
      answer: choice,
      correct,
      reversal: last?.reversal ?? false,
      responseMs: Math.round(performance.now() - trial.shownAt),
      switches: trial.switches,
      loudnessGainDb: trial.audio.gainDb,
    });
    s.current = null;
    this.player.stop();
    // No right/wrong feedback: it would tell the listener which version is
    // which, and the test is meant to measure hearing, not learning.
    if (s.staircase.isFinished) this.showResults();
    else void this.loadTrial();
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.step !== 'quiz' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'a' || key === 'b' || key === 'x') {
      if (this.abxButtons[0]?.disabled) return;
      this.listen(key.toUpperCase() as AbxKey);
    } else if (key === '1' || key === '2') {
      if (this.answerA.disabled) return;
      this.answer(key === '1' ? 'A' : 'B');
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- Results ---------------------------------------------------------

  private headphoneSummary(s: Session): { correct: number; passed: boolean } {
    const correct = s.headphoneRecords.filter((r) => r.correct).length;
    return { correct, passed: headphoneCheckPassed(correct) };
  }

  private showResults(): void {
    const s = this.session;
    if (!s) return;
    this.show('results');
    const estimate = s.staircase.threshold();
    const score = scoreTrials(s.records);
    const hp = this.headphoneSummary(s);
    const t = estimate.thresholdDb;

    $('#result-value').textContent = `${t > 0 ? '+' : ''}${t.toFixed(1)} dB`;
    $('#result-headline').textContent = interpretThreshold(t);
    const caveats: string[] = [];
    if (!estimate.reliable) caveats.push('Low confidence: the test ended before your answers settled.');
    if (!hp.passed) caveats.push('Headphones were not confirmed, so this may reflect speaker playback.');
    const caveat = $('#result-caveat');
    caveat.hidden = caveats.length === 0;
    caveat.textContent = caveats.join(' ');
    const rows: [string, string][] = [
      ['Passage', `${formatClock(s.region.startSeconds)}, ${Math.round(s.region.durationSeconds)} s`],
      ['Correct', `${score.correct} of ${score.total} (${score.percentCorrect.toFixed(0)}%)`],
      ['Chance of this by guessing', formatP(score.pValue)],
      ['Sensitivity (d′)', score.dPrime.toFixed(2)],
      ['Headphone check', `${hp.passed ? 'Passed' : 'Not passed'} (${hp.correct} of ${HEADPHONE_TRIALS})`],
    ];
    const stats = $('#result-stats');
    stats.replaceChildren(
      ...rows.flatMap(([term, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    $('#result-chart').innerHTML = renderStaircaseChart(s.records, t);

    const history = addHistory({
      at: new Date().toISOString(),
      thresholdDb: t,
      reliable: estimate.reliable,
      headphonesPassed: hp.passed,
      passageSeconds: Math.round(s.region.durationSeconds),
      song: s.region.songName,
    });
    this.renderHistory(history, s.region.intent);
  }

  private renderHistory(history: HistoryEntry[], intent: Intent): void {
    const panel = $('#history-panel');
    // A single result has nothing to compare with, unless the user came to
    // track fatigue, where the note explains what to do next.
    panel.hidden = history.length < 2 && intent !== 'fatigue';
    $('#history-note').textContent =
      intent === 'fatigue'
        ? 'Take the test again after a few hours of listening, with the same song and passage. ' +
          'A threshold that rises over the day suggests tired ears.'
        : 'Earlier results on this device, newest first. Use the same song and passage to compare like with like.';
    const items = history
      .slice(-8)
      .reverse()
      .map((entry, i) => {
        const li = document.createElement('li');
        if (i === 0) li.className = 'is-latest';
        const when = document.createElement('span');
        when.textContent = `${new Date(entry.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${entry.song}`;
        const value = document.createElement('b');
        value.textContent = `${entry.thresholdDb > 0 ? '+' : ''}${entry.thresholdDb.toFixed(1)} dB`;
        li.append(when, value);
        return li;
      });
    $('#history-list').replaceChildren(...items);
  }

  /** Saves the result card as a PNG, through the share sheet where available (phones). */
  private async shareCard(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const estimate = s.staircase.threshold();
    const score = scoreTrials(s.records);
    const hp = this.headphoneSummary(s);
    const blob = await renderResultCard({
      thresholdDb: estimate.thresholdDb,
      reliable: estimate.reliable,
      interpretation: interpretThreshold(estimate.thresholdDb),
      correct: score.correct,
      total: score.total,
      pValueText: formatP(score.pValue),
      dPrime: score.dPrime,
      headphonesPassed: hp.passed,
      passageSeconds: Math.round(s.region.durationSeconds),
      date: new Date(),
      trials: s.records,
      minDb: s.staircase.config.minDb,
      maxDb: s.staircase.config.maxDb,
    });
    const file = new File([blob], 'masked-result.png', { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Masked result' });
        return;
      }
    } catch (error) {
      // Closing the share sheet is not an error worth reporting.
      if ((error as Error).name === 'AbortError') return;
    }
    download(blob, file.name);
  }

  private exportJson(): void {
    const s = this.session;
    if (!s) return;
    const estimate = s.staircase.threshold();
    const report = {
      app: 'Masked',
      note: 'Not a medical hearing test.',
      startedAt: s.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      song: s.region.songName,
      intent: s.region.intent,
      region: { startSeconds: s.region.startSeconds, durationSeconds: s.region.durationSeconds },
      sampleRate: s.region.sampleRate,
      headphoneCheck: { ...this.headphoneSummary(s), trials: s.headphoneRecords },
      staircase: { config: s.staircase.config, reversals: s.staircase.reversals },
      threshold: estimate,
      interpretation: interpretThreshold(estimate.thresholdDb),
      score: scoreTrials(s.records),
      trials: s.records,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    download(blob, `masked-results-${s.startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked later: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function formatP(p: number): string {
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p.toFixed(3)}`;
}
