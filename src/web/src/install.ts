// On the first visit from a phone or tablet in a browser tab, suggest installing the game as an app, which opens full
// screen. Once (localStorage barkley.install); Start removes it.
import { createSignal } from 'solid-js';
import { isApp, storage } from './page';

export const ios =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const [installOpen, setInstallOpen] = createSignal(false);
// Chrome can show its own install dialog, but only once it decides the page qualifies, so the Install button appears
// when it does.
export const [installPrompt, setInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(null);

export function offerInstall() {
  const touch = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
  if (isApp() || !touch || storage.get('barkley.install') !== null) return;
  storage.set('barkley.install', '1');
  addEventListener('beforeinstallprompt', (e) => {
    if (!installOpen()) return;
    e.preventDefault();
    setInstallPrompt(e);
  });
  setInstallOpen(true);
}
