// The page around the game. index.html loads this before the game's own script, so everything that has to be in place
// before the runtime loads (the hold before Game Start, the texture progress, the audio fixes) is.
// The design system's tokens and controls first, so every component's stylesheet comes after them.
import './ui/base.css';
import { render } from 'solid-js/web';
import { padMuted } from './extensions/gamepad';
import { exposeToGame, extension } from './extensions/index';
import { resumeState } from './extensions/resume';
import { offerInstall } from './install';
import { saveOffline } from './offline';
import { fuzz, started, type Api } from './page';
import { installAudio, reportNoOgg } from './runtime/audio';
import { installHold } from './runtime/hold';
import { installTextureProgress } from './runtime/loading';
import { load, markReady, openControls, start } from './start';
import { App } from './ui/App';

const api: Api = {
  get started() {
    return started();
  },
  load,
  ready: markReady,
  start,
  controls: openControls,
  offlineSave: saveOffline,
  extension,
  get resumeState() {
    return resumeState();
  },
  get padMuted() {
    return padMuted();
  },
};
window.barkley = api;

reportNoOgg();
if (!fuzz) {
  installHold(markReady);
  installTextureProgress();
  installAudio();
}
exposeToGame();
offerInstall();
render(() => <App />, document.getElementById('page')!);
