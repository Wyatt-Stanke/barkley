// Everything the page draws around the game. Until Start: the Start screen, and on a first visit from a phone the
// install prompt. Over the game: the touch overlay. Over everything, as the game or the Start screen asks: the
// Controls, Saves and crash report panels, in that order (a crash report goes on top).
import { Show } from 'solid-js';
import { controlsOpen } from '../extensions/controls';
import { crashReport } from '../extensions/crash';
import { savesOpen } from '../extensions/saves';
import { ready as touchReady } from '../extensions/touch';
import { installOpen } from '../install';
import { started } from '../page';
import { ControlsPanel } from './ControlsPanel';
import { CrashPanel } from './CrashPanel';
import { InstallPrompt } from './InstallPrompt';
import { SavesPanel } from './SavesPanel';
import { StartScreen } from './StartScreen';
import { TouchOverlay } from './TouchOverlay';

export function App() {
	return (
		<>
			<Show when={!started()}>
				<StartScreen />
				<Show when={installOpen()}>
					<InstallPrompt />
				</Show>
			</Show>
			<Show when={touchReady()}>
				<TouchOverlay />
			</Show>
			<Show when={controlsOpen()}>
				<ControlsPanel />
			</Show>
			{/* keyed: each saves_open is a fresh panel */}
			<Show when={savesOpen()} keyed>
				{(_opening) => <SavesPanel />}
			</Show>
			<Show when={crashReport()} keyed>
				{(r) => <CrashPanel kind={r.kind} text={r.text} />}
			</Show>
		</>
	);
}
