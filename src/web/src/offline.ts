// Offline play: sw.js keeps a whole build in the browser's storage and downloads a newer one in full before it takes
// over from the one in use. It is registered once the game has loaded, so it never shares the first visit's
// bandwidth, and it asks for a check then, whenever the tab comes back, and when the machine comes back online. An
// installed app downloads on every check; a browser tab only looks, and the Start screen offers the download as a
// link (saveOffline), since a hundred megabytes is a lot to take from someone just trying the game. Never under the
// fuzz harness or with ?nosw in the URL: the tooling's own servers would be handing out a hundred megabytes a run,
// and the fuzzer needs each build served fresh.
import { batch, createSignal } from 'solid-js';
import { fuzz, isApp } from './page';

// What the worker says (sw.js, tell): the build it serves (version, id, complete), the one on the server (latest,
// when the check reached it), and a download under way or an error.
type Said = {
  version?: string | null;
  id?: string | null;
  complete?: boolean;
  latest?: { version: string; id: string } | null;
  downloading?: { version: string; done: number; total: number; core: boolean } | null;
  error?: string | null;
};

const [said, setSaid] = createSignal<Said | null>(null); // what the worker said last, which knows more than version.json
const [want, setWant] = createSignal(false); // download on a check: an installed app always, a tab once asked to
const [version, setVersion] = createSignal(''); // the version in version.json, until the worker says
let checkedAt = 0; // the last check, so coming back to the tab doesn't ask over and over

export function registerOffline() {
  if (fuzz || /(^|[?&])nosw\b/.test(location.search) || !navigator.serviceWorker) return;
  setWant(isApp());
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'offline') return;
    batch(() => {
      // a download that failed in a tab offers its link again, to try again
      if (e.data.error && !isApp()) setWant(false);
      setSaid(e.data);
    });
  });
  navigator.serviceWorker.register('sw.js').then(
    () => {
      addEventListener('online', () => check());
      addEventListener('visibilitychange', () => check());
      check();
    },
    () => {},
  );
}

function check(now = false) {
  navigator.serviceWorker.ready.then((reg) => {
    const w = reg.active || navigator.serviceWorker.controller;
    if (!w || document.visibilityState !== 'visible') return;
    if (!now && Date.now() - checkedAt < 60000) return;
    checkedAt = Date.now();
    w.postMessage({ type: 'check', download: want() });
  });
}

// The Start screen's offline link, in a browser tab: download the build (or the rest of it, or a newer one)
export function saveOffline() {
  setWant(true);
  // the player asked for this copy, so ask the browser to keep it when storage runs low (Firefox asks them)
  navigator.storage?.persist?.().catch(() => {});
  if (navigator.serviceWorker) check(true);
}

// The version, under the Start word: which build of the port this is, without anyone having to look for it. Every
// build carries version.json, so this works whether or not the worker is in: a browser with no service workers, or a
// page opened with ?nosw, still shows it. The worker knows more (it can say the copy is saved for offline play, and it
// knows the version offline, where this fetch can't reach), so whatever it has said stands.
export function loadVersion() {
  if (fuzz) return;
  fetch('version.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((v) => setVersion(v.version))
    .catch(() => {});
}

// The Start screen's line: the version, then the offline copy, which is how far it has got, or in a browser tab a
// link to save it, finish it or update it, which turns into the progress when clicked.
export function offlineLine(): { text: string; link: string } {
  const s = said() ?? {},
    d = s.downloading,
    n = s.latest;
  const v = s.version || n?.version || version();
  const parts = v ? ['v' + v] : [];
  let link = '';
  // the server has what this browser doesn't: a whole build, the rest of one, or a newer one
  const behind = !!n && (s.id !== n.id || !s.complete);
  const to = n && n.version !== s.version ? ' to v' + n.version : '';
  if (d || (behind && want() && !s.error)) {
    const pct = d ? ' ' + Math.floor((100 * d.done) / Math.max(1, d.total)) + '%' : '';
    if (n && s.id && s.id !== n.id) parts.push('Updating' + to + pct);
    else parts.push((d && !d.core ? 'Saving the music' : 'Saving for offline play') + pct);
  } else {
    if (s.complete) parts.push('Ready to play offline');
    if (behind && !want())
      link = !s.id ? 'Save for offline play' : s.id === n!.id ? 'Finish saving for offline play' : 'Update' + to;
  }
  return { text: parts.join(' · '), link };
}
