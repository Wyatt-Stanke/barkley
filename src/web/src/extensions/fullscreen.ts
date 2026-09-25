// Fullscreen, whose window_set_fullscreen does nothing on HTML5. Patch 14 and modernized/05 call these for the
// Configuration menu's SCREEN setting. A page may enter fullscreen only shortly after a key press or click, so without
// one it waits for the next.
let wanted = false;
const RETRY = ['keydown', 'mousedown', 'touchend'];

export function fullscreen_get() {
  return document.fullscreenElement || document.webkitFullscreenElement ? 1 : 0;
}

export function fullscreen_set(on: number) {
  const d = document,
    el = d.documentElement;
  wanted = on >= 0.5;
  if (+wanted === fullscreen_get()) return 0;
  if (!wanted) {
    (d.exitFullscreen || d.webkitExitFullscreen)!.call(d);
    return 0;
  }
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return 0; // iPhone Safari has no element fullscreen
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    later();
    return 0;
  }
  const p = request.call(el);
  if (p) p.catch(later);
  return 0;
}

function later() {
  for (const type of RETRY) addEventListener(type, retry, true);
}

function retry() {
  for (const type of RETRY) removeEventListener(type, retry, true);
  if (wanted) fullscreen_set(1);
}
