/**
 * Results kept on this device, for the ear-fatigue use case: comparing a
 * threshold now with one taken hours later. Stored in localStorage only, and
 * every access is guarded, because storage can be unavailable (private
 * browsing, blocked site data) and the app must work without it.
 */

export interface HistoryEntry {
  at: string;
  thresholdDb: number;
  reliable: boolean;
  headphonesPassed: boolean;
  passageSeconds: number;
  song: string;
}

const KEY = 'masked.history.v1';
const MAX_ENTRIES = 50;

function isEntry(value: unknown): value is HistoryEntry {
  const v = value as Partial<HistoryEntry>;
  return typeof v === 'object' && v !== null && typeof v.at === 'string' && typeof v.thresholdDb === 'number';
}

export function loadHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Adds an entry and returns the updated list, newest last. */
export function addHistory(entry: HistoryEntry): HistoryEntry[] {
  const list = [...loadHistory(), entry].slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the result is still shown, just not remembered.
  }
  return list;
}
