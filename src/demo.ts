/**
 * Slot for a built-in demo track. To enable it, put the audio file in
 * public/demo/ and set `file` to its name; Vite copies public/ into the build
 * as-is. While this is null the demo button stays hidden.
 */
export const DEMO_TRACK: { title: string; file: string } | null = null;

/** Where the demo file is served from. BASE_URL keeps it working under the
 *  GitHub Pages /masked/ path as well as on the local dev server. */
export function demoTrackUrl(file: string): string {
  return `${import.meta.env.BASE_URL}demo/${encodeURIComponent(file)}`;
}
