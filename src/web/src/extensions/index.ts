// The functions the game calls (the GameMaker extensions' functions, which import.mjs declares, and the loading bar it
// names), as page globals, and what turns each extension on.
import { addExtension, type Extension, has } from '../page';
import { barkley_loading } from '../runtime/loading';
import { controls_show } from './controls';
import { crash_end, crash_put, crash_step, crash_wanted, enableCrash } from './crash';
import { fullscreen_get, fullscreen_set } from './fullscreen';
import { enableGamepad, pad_context, pad_keys } from './gamepad';
import { enableResume, resume_clear, resume_put, resume_take } from './resume';
import { saves_open } from './saves';
import * as touch from './touch';

// Compiled GML calls these by name, looked up when it calls them; fuzz.mjs's harness replaces some of them.
export function exposeToGame() {
  Object.assign(window, {
    barkley_loading,
    fullscreen_set,
    fullscreen_get,
    resume_put,
    resume_take,
    resume_clear,
    saves_open,
    touch_keys: touch.touch_keys,
    touch_context: touch.touch_context,
    touch_active: touch.touch_active,
    touch_view_x: touch.touch_view_x,
    touch_view_y: touch.touch_view_y,
    touch_view_w: touch.touch_view_w,
    touch_view_h: touch.touch_view_h,
    touch_dpr: touch.touch_dpr,
    pad_keys,
    pad_context,
    controls_show,
    crash_put,
    crash_step,
    crash_wanted,
    crash_end,
  });
}

// What an extension does as it loads (the others only need their functions, which are always here)
const ENABLE: Partial<Record<Extension, () => void>> = {
  Resume: enableResume,
  Touch: touch.enableTouch,
  Gamepad: enableGamepad,
  Crash: enableCrash,
};

// Each extension's file (written by import.mjs) calls this as the runtime loads it.
export function extension(name: string) {
  if (has(name as Extension)) return;
  addExtension(name);
  ENABLE[name as Extension]?.();
}
