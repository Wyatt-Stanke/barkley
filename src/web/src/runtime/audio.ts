// The page's fixes to how the runtime plays sound.
import { folder, started } from '../page';

// Safari decodes Ogg Vorbis with the first ~26 ms of each sound missing; report no Ogg support so the runtime loads the
// MP3s.
export function reportNoOgg() {
  const canPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return /ogg/i.test(type) ? '' : canPlayType.call(this, type);
  };
}

// Every AudioContext the runtime makes, so Start can resume them: the runtime unlocks audio on a pointer press only,
// and a key can start the game too.
const contexts: AudioContext[] = [];
export const resumeAudio = () => {
  for (const c of contexts) c.resume().catch(() => {});
};

// The music is streamed: the runtime downloads and decodes a track only when it first plays, so the intro (mSpace,
// 6 MB) was silent for several seconds after Start. Once the game has loaded, the page decodes it while the Start
// screen waits; `early` is then { size, buffer }, and null once used or given up (undefined: not asked for yet).
let early: { size: number; buffer: Promise<AudioBuffer> } | null | undefined;
let decode: BaseAudioContext['decodeAudioData'] | undefined; // the browser's own
export const giveUpEarlyMusic = () => (early = null); // never asked for (a game that resumed and plays nothing streamed)

// The runtime plays a streamed sound (all the music) by downloading and decoding it, and then starts the sound object
// that asked, even if the game stopped it meanwhile; by then the runtime may have reused that object for the next sound.
// So music switched away from in its first seconds (the intro's, when it is skipped at once) played on, under the
// next track or in its place, beyond the game's reach. Each play and stop now counts a generation on the sound object;
// the download a play starts carries that generation, and a decode whose sound has moved on is never handed back.
interface Voice {
  barkleyGen?: number;
}
interface Tag {
  voice: Voice;
  gen: number;
}
let playing: Tag | null = null; // while a play runs
let decoding: Tag | null = null; // the same, from a finished download until its decode begins

export function installAudio() {
  // The runtime's decode of the intro's music gets the buffer earlyMusic made while Start waited. After Start, the
  // first decode that isn't that file means the game went elsewhere: drop it.
  if (window.BaseAudioContext) {
    const native = BaseAudioContext.prototype.decodeAudioData;
    decode = native;
    BaseAudioContext.prototype.decodeAudioData = function (
      this: BaseAudioContext,
      data: ArrayBuffer,
      ok?: DecodeSuccessCallback | null,
      fail?: DecodeErrorCallback | null,
    ) {
      const e = early;
      const tag = decoding; // the sound whose download this is
      decoding = null;
      let p: Promise<AudioBuffer>;
      if (e && data && data.byteLength === e.size) {
        early = null;
        p = e.buffer.catch(() => native.call(this, data));
        if (ok) p.then(ok, fail ?? undefined);
      } else {
        if (started() && e !== null) early = null;
        p = native.call(this, data, ok, fail);
      }
      if (!tag) return p;
      // stopped or reused meanwhile: never hand the buffer back, so the runtime never starts it
      return p.then((buffer) => (tag.voice.barkleyGen === tag.gen ? buffer : new Promise<AudioBuffer>(() => {})));
    };
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    // biome-ignore lint/complexity/useArrowFunction: the runtime calls it with new, which an arrow function can't take
    const Recorded = function (options?: AudioContextOptions) {
      const c = new AC(options);
      contexts.push(c);
      return c;
    } as unknown as typeof AudioContext;
    Recorded.prototype = AC.prototype;
    window.AudioContext = Recorded;
  }
}

export function earlyMusic() {
  const ctx = contexts[0];
  if (!ctx || !decode) return;
  const native = decode;
  fetch(`${folder}/mSpace.mp3`)
    .then((r) => {
      if (!r.ok) throw r.status;
      return r.arrayBuffer();
    })
    .then((data) => {
      if (early !== undefined) return; // already given up
      early = { size: data.byteLength, buffer: native.call(ctx, data) };
      early.buffer.catch(() => {});
    })
    .catch(() => {});
}

// The runtime's names change from build to build, so its sound class is found by its methods. Runs once the game's
// script has loaded (and under the fuzz harness too).
export function fixStreamedSounds() {
  const Voice = Object.getOwnPropertyNames(window)
    .filter((n) => n.charAt(0) === '_')
    .map((n) => {
      try {
        return (window as unknown as Record<string, unknown>)[n];
      } catch {
        return null;
      }
    })
    .find((f): f is { prototype: Record<string, (...a: unknown[]) => unknown> } => {
      const p = typeof f === 'function' && f.prototype;
      return (
        !!p &&
        ['play', 'stop', 'start', 'pause'].every((m) => Object.hasOwn(p, m) && typeof p[m] === 'function') &&
        /AudioBufferSourceNode/.test(String(p.start))
      );
    });
  if (!Voice) return console.warn("barkley: the runtime's sound class wasn't found");
  const P = Voice.prototype,
    play = P.play,
    stop = P.stop,
    open = XMLHttpRequest.prototype.open;
  P.play = function (this: Voice, ...args: unknown[]) {
    this.barkleyGen = (this.barkleyGen || 0) + 1;
    playing = { voice: this, gen: this.barkleyGen };
    try {
      return play.apply(this, args);
    } finally {
      playing = null;
    }
  };
  P.stop = function (this: Voice, ...args: unknown[]) {
    this.barkleyGen = (this.barkleyGen || 0) + 1;
    return stop.apply(this, args);
  };
  // The runtime sets the download's onload after open, so this listener runs just before it, and its decodeAudioData
  // call picks the tag up; a timeout clears it if the download failed instead.
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const tag = playing;
    if (tag)
      this.addEventListener('load', () => {
        decoding = tag;
        setTimeout(() => {
          if (decoding === tag) decoding = null;
        });
      });
    return (open as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
}
