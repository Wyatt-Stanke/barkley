// The Controls panel, which the Start screen's Controls link opens before the game runs: one table of the seven
// controls, with the keys as the player has them (on a touch device, the touch controls instead) and the controller's
// buttons, whose rows light up as they are pressed, from the keyboard or from a pad, so it is its own test. The
// Controller heading says whether a pad is connected (a browser shows one only once a button on it has been pressed).
//
// Nothing pressed in it reaches the game or the Start screen: the panel keeps its key events, the Start screen's key
// handler stands down while it is up, and the gamepad extension is asked to go quiet.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { bindings, CONTROLS, controlOf, keyName, padControls, setControlsOpen } from '../extensions/controls';
import { padQuiet, pads } from '../extensions/gamepad';
import { cfg, touchDevice } from '../extensions/touch';
import type { Control } from '../runtime/keys';
import { Panel } from './Panel';
import './ControlsPanel.css';

// The controller's side, by the gamepad extension's mapping (PAD_BUTTON), and the touch overlay's
type Column = Partial<Record<Control, string>>;
const PAD: Column = { up: 'D-pad / stick', action: 'A', cancel: 'B', start: 'Start' };
// A column whose directions share one cell, which spans their four rows and is never lit
function Cell(props: { c: Control; column: Column }) {
	return (
		<Show when={props.column[props.c]}>
			<td class={props.c === 'up' ? 'ctl-dirs' : undefined} rowSpan={props.c === 'up' ? 4 : undefined}>
				{props.column[props.c]}
			</td>
		</Show>
	);
}
// The page's font (Inter's Latin subset) has ↑ but not ← or →, which fell back to a smaller face, so every arrow key
// is its ↑, turned.
const TURN: Record<number, number> = { 37: -90, 38: 0, 39: 90, 40: 180 };
function Key(props: { code: number }) {
	return (
		<Show when={props.code in TURN} fallback={keyName(props.code)}>
			<span class="ctl-arrow" role="img" aria-label={keyName(props.code)} style={{ rotate: `${TURN[props.code]}deg` }}>
				↑
			</span>
		</Show>
	);
}

export function ControlsPanel() {
	const keys = bindings();
	// A phone or tablet has no keyboard to speak of: it gets the touch controls, as the player has them set
	const touch: Column | null = touchDevice()
		? { up: cfg.mode === 'dpad' ? 'D-pad' : 'Joystick', action: 'A', cancel: 'B', start: 'Start' }
		: null;
	const held = new Set<number>();
	const [on, setOn] = createStore<Partial<Record<Control, boolean>>>({});
	const [connected, setConnected] = createSignal(false);
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
		const live = pads();
		padControls(live, next);
		for (const [c] of CONTROLS) setOn(c, !!next[c]);
		setConnected(live.length > 0);
	};
	let timer = 0;
	onMount(() => {
		padQuiet(true);
		addEventListener('blur', forget);
		timer = setInterval(tick, 50);
		tick();
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
						<th>{touch ? 'Touch' : 'Keyboard'}</th>
						<th>
							Controller
							<span class="ctl-conn" classList={{ on: connected() }}>
								{connected() ? 'Connected' : 'Not connected'}
							</span>
						</th>
					</tr>
				</thead>
				<tbody>
					<For each={CONTROLS}>
						{([c, name]) => (
							<tr classList={{ on: !!on[c] }} data-control={c}>
								<th>{name}</th>
								<Show
									when={touch}
									fallback={
										<td>
											<Key code={keys[c]} />
										</td>
									}
								>
									{(t) => <Cell c={c} column={t()} />}
								</Show>
								<Cell c={c} column={PAD} />
							</tr>
						)}
					</For>
				</tbody>
			</table>
			<p class="ui-mute">
				{touch
					? 'The touch controls come up when the game starts, with a settings button to change them. Press a button on a controller to try it.'
					: "Press a key or button to try it. To change keys, choose SET KEYS in the game's Configuration menu."}
			</p>
		</Panel>
	);
}
