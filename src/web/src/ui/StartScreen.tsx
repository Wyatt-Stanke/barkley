// The Start screen, which is itself the Start button: the whole page, so a click or tap anywhere starts. The game's
// name, "Start" in large type, which fills from grey to white as the game loads behind it, and a hint, set on the left
// edge of where the 4:3 picture will be; under them the version and the offline copy. At the foot, the Controls link
// and, when a resume state is waiting, a way to begin at the title screen instead.
import { createEffect, createMemo, Show } from 'solid-js';
import { controlsOpen } from '../extensions/controls';
import { RESUME_KEY } from '../extensions/resume';
import { installOpen } from '../install';
import { offlineLine, saveOffline } from '../offline';
import { fuzz, has, ready, storage } from '../page';
import { progress } from '../runtime/loading';
import { openControls, start } from '../start';
import './StartScreen.css';

// Start resumes where the last session left off when resume.ts kept its state
const resuming = !!storage.get(RESUME_KEY) && !fuzz;

export function StartScreen() {
  let button!: HTMLButtonElement;
  // Enter starts once the game has loaded, and focus comes back here from the install prompt and the Controls panel
  createEffect(() => ready() && !installOpen() && !controlsOpen() && button.focus());
  const line = createMemo(offlineLine);
  return (
    <>
      <button
        type="button"
        id="start"
        ref={button}
        disabled={!ready()}
        onClick={() => start()}
        aria-labelledby="face-word"
      />
      <div id="face">
        <span class="name">Barkley, Shut Up and Jam: Gaiden</span>
        <span class="word" id="face-word" style={{ '--p': `${progress()}%` }}>
          Start
        </span>
        <Show when={ready()} fallback={<span class="hint">Loading</span>}>
          <span class="hint key">Click or press any key</span>
          <span class="hint touch">Tap anywhere</span>
        </Show>
        <Show when={line().text || line().link}>
          <span class="hint" id="offline">
            <span id="offline-text">{line().text && line().link ? `${line().text} · ` : line().text}</span>
            <Show when={line().link}>
              <button type="button" class="ui-link" id="offline-go" onClick={saveOffline}>
                {line().link}
              </button>
            </Show>
          </span>
        </Show>
      </div>
      <div id="foot">
        <Show when={ready() && has('Controls')}>
          <div id="ctlbar">
            <button type="button" class="ui-link" id="controls-go" onClick={openControls}>
              Controls
            </button>
          </div>
        </Show>
        <Show when={resuming}>
          <div id="fresh">
            <span>Continues where you left off.</span>
            <button type="button" class="ui-link" id="fresh-go" disabled={!ready()} onClick={() => start(true)}>
              Start from the title screen
            </button>
          </div>
        </Show>
      </div>
    </>
  );
}
