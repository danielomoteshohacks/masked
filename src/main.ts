import './style.css';

// Safari before 14.1 only exposed the prefixed constructor. Checking both lets
// us give a clear message instead of failing later with a cryptic error.
// The TypeScript DOM types declare AudioContext as always present, so we look it
// up loosely: on an old browser the property genuinely may not exist.
type MaybeAudioGlobals = { AudioContext?: unknown; webkitAudioContext?: unknown };

function hasWebAudio(scope: MaybeAudioGlobals): boolean {
  return typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function';
}

function renderStatus(target: HTMLElement): void {
  if (hasWebAudio(window as MaybeAudioGlobals)) {
    target.textContent =
      'Your browser supports the Web Audio API. Song loading arrives in the next version.';
    target.dataset.state = 'ok';
  } else {
    target.textContent =
      'Your browser does not support the Web Audio API, which Masked needs to process audio. ' +
      'Try a current version of Chrome, Firefox, Edge or Safari.';
    target.dataset.state = 'error';
  }
}

const statusEl = document.querySelector<HTMLElement>('#status');
// If the element is missing the HTML and script are out of sync; failing loudly
// in the console is more useful than silently doing nothing.
if (!statusEl) {
  throw new Error('Masked: #status element not found in index.html');
}
renderStatus(statusEl);
