// The game loads behind the Start screen: GameMaker_Init runs on page load, and the runtime is held at the one gap
// between loading and Game Start until Start is pressed, so Start begins the game at once. The runtime's frame state
// machine starts the game in the same frame that sees the last asset loaded; the gap is "Entering main loop...", which
// it logs after all loading and just before Game Start. There a console.log hook throws a sentinel out of the frame,
// the requestAnimationFrame wrapper catches it, and every frame after that waits in `held` until release().
//
// Not under the fuzz harness, which wraps the game's functions before GameMaker_Init and runs its own frames.
import { started } from '../page';

const HOLD = {};
let holding = false;
const held: FrameRequestCallback[] = [];

export function installHold(onReady: () => void) {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      if (holding) return void held.push(cb);
      try {
        cb(t);
      } catch (e) {
        if (e !== HOLD) throw e;
      }
    });
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (args[0] === 'Entering main loop...' && !started() && !holding) {
      holding = true;
      onReady();
      throw HOLD;
    }
    return log.apply(console, args);
  };
}

export function release() {
  holding = false;
  for (const cb of held.splice(0)) window.requestAnimationFrame(cb);
}
