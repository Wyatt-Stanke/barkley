// The Controls panel, which the Start screen's Controls link opens before the game runs: one table of the seven
// controls, with the keys as the player has them and the controller's buttons, whose rows light up as they are
// pressed, from the keyboard or from a pad, so it is its own test.
//
// Nothing pressed in it reaches the game or the Start screen: the panel keeps its key events, the Start screen's key
// handler stands down while it is up, and the gamepad extension is asked to go quiet.
import { For, onCleanup, onMount, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { aliases, bindings, CONTROLS, controlOf, keyName, padControls, setControlsOpen } from '../extensions/controls';
import { padQuiet, pads } from '../extensions/gamepad';
import type { Control } from '../runtime/keys';
import { Panel } from './Panel';
import './ControlsPanel.css';

// The controller's side, by the gamepad extension's mapping (PAD_BUTTON); the directions share one cell.
const PAD: Partial<Record<Control, string>> = { up: 'D-pad / stick', action: 'A', cancel: 'B', start: 'Start' };

export function ControlsPanel() {
	const keys = bindings();
	const held = new Set<number>();
	const [on, setOn] = createStore<Partial<Record<Control, boolean>>>({});
	const forget = () => held.clear();

	// A timer, not requestAnimationFrame: the Start screen holds every frame callback back until the game starts
	// (runtime/hold.ts), which would leave this test frozen exactly where it is most used. 20 a second is plenty to see
	// a button go down.
	const tick = () => {
		const next: Partial<Record<Control, boolean>> = {};
		for (const code of held) {
			const c = controlOf(keys, code);
			if (c) next[c] = true;
		}
		padControls(pads(), next);
		for (const [c] of CONTROLS) setOn(c, !!next[c]);
	};
	let timer = 0;
	onMount(() => {
		padQuiet(true);
		addEventListener('blur', forget);
		timer = setInterval(tick, 50);
	});
	onCleanup(() => {
		clearInterval(timer);
		removeEventListener('blur', forget);
		padQuiet(false);
	});

	return (
		<Panel
			id="controls-panel"
			title="Controls"
			onClose={() => setControlsOpen(false)}
			onKeyDown={(e) => held.add(e.which || e.keyCode)}
			onKeyUp={(e) => held.delete(e.which || e.keyCode)}
		>
			<table class="ctl-table">
				<thead>
					<tr>
						<th />
						<th>Keyboard</th>
						<th>Controller</th>
					</tr>
				</thead>
				<tbody>
					<For each={CONTROLS}>
						{([c, name]) => (
							<tr classList={{ on: !!on[c] }} data-control={c}>
								<th>{name}</th>
								<td>{[keyName(keys[c]), ...aliases(keys, c)].join(' / ')}</td>
								<Show when={PAD[c]}>
									<td class={c === 'up' ? 'ctl-dirs' : undefined} rowSpan={c === 'up' ? 4 : undefined}>
										{PAD[c]}
									</td>
								</Show>
							</tr>
						)}
					</For>
				</tbody>
			</table>
			<p class="ui-mute">Press a key or button to try it. Change keys in the game: Configuration → SET KEYS.</p>
		</Panel>
	);
}
