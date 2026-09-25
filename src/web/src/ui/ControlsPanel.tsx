// The Controls panel, which the Start screen's Controls link opens before the game runs. It says what the game
// listens to (the keys as the player has them, the controller mapping, and where to change them) and then lets the
// player prove it hears them: every control lights up as it is pressed, from the keyboard or from a pad, with the
// pad's name, raw buttons and sticks beside it for a pad that maps itself oddly.
//
// Nothing pressed in it reaches the game or the Start screen: the panel keeps its key events, the Start screen's key
// handler stands down while it is up, and the gamepad extension is asked to go quiet.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
	aliases,
	bindings,
	CONTROLS,
	controlOf,
	defaultsLine,
	keyName,
	label,
	padControls,
	setControlsOpen,
} from '../extensions/controls';
import { padQuiet, pads, pressed } from '../extensions/gamepad';
import type { Control } from '../runtime/keys';
import { Panel } from './Panel';
import './ControlsPanel.css';

// A binding row: the control on the left, what presses it on the right.
function Binding(props: { label: string; keys: string[]; note?: string }) {
	return (
		<>
			<dt>{props.label}</dt>
			<dd>
				<For each={props.keys}>
					{(k, i) => (
						<>
							<Show when={i()}>
								<span class="ctl-or">or</span>
							</Show>
							<span class="ctl-key">{k}</span>
						</>
					)}
				</For>
				<Show when={props.note}>
					<span class="ctl-note">{props.note}</span>
				</Show>
			</dd>
		</>
	);
}

export function ControlsPanel() {
	const b = bindings();
	const close = () => setControlsOpen(false);

	// ---- the test
	const keyHeld = new Set<number>();
	const [on, setOn] = createStore<Partial<Record<Control, boolean>>>({});
	const [last, setLast] = createSignal('Press something.');
	const [status, setStatus] = createSignal('');
	const [raw, setRaw] = createSignal('');
	const forget = () => keyHeld.clear();

	// A timer, not requestAnimationFrame: the Start screen holds every frame callback back until the game starts
	// (runtime/hold.ts), which would leave this test frozen exactly where it is most used. 20 a second is plenty to see
	// a button go down.
	const tick = () => {
		const live = pads(),
			g = live[0],
			next: Partial<Record<Control, boolean>> = {};
		for (const code of keyHeld) {
			const c = controlOf(b.keys, code);
			if (c) next[c] = true;
		}
		padControls(live, next);
		for (const [c] of CONTROLS) setOn(c, !!next[c]);
		if (!live.length) {
			setStatus('No controller yet. Connect one and press a button on it — the keyboard works here too.');
			setRaw('');
			return;
		}
		setStatus(live.length === 1 ? `Controller: ${g.id || 'connected'}` : `${live.length} controllers connected`);
		const down = [...g.buttons].flatMap((x, i) => (pressed(x) ? [i] : []));
		const axes = [...g.axes].slice(0, 4).map((a) => a.toFixed(2));
		setRaw(`Buttons down: ${down.length ? down.join(' ') : 'none'}  ·  Sticks: ${axes.join(' ')}`);
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
			onClose={close}
			onKeyDown={(e) => {
				const code = e.which || e.keyCode;
				keyHeld.add(code);
				const c = controlOf(b.keys, code);
				setLast(keyName(code) + (c ? ` → ${label(c)}` : ' → not bound to anything; the game ignores it'));
			}}
			onKeyUp={(e) => keyHeld.delete(e.which || e.keyCode)}
		>
			<p class="ui-mute">
				What the game listens to, and a test below to see that it hears you. Close this and press Start to play.
			</p>
			<div class="ui-cols">
				<section class="ui-col">
					<h3>Keyboard</h3>
					<dl class="ctl-list">
						<For each={CONTROLS}>
							{([c, name]) => <Binding label={name} keys={[keyName(b.keys[c]), ...aliases(b.keys, c)]} />}
						</For>
					</dl>
					<p class="ui-mute">{defaultsLine(b)} Enter also confirms in menus, and Esc leaves full screen.</p>
					<h3>Changing them</h3>
					<p>
						Start the game, and on the title menu choose Configuration → SET KEYS: it then asks for the key you want for
						each control in turn. Configuration → SETTINGS → Default puts them all back.
					</p>
					<p class="ui-mute">Full screen, picture size and volume are in Configuration too.</p>
				</section>
				<section class="ui-col">
					<h3>Controller</h3>
					<p>Connect a controller and press one of its buttons: a browser hides a pad until it has been used once.</p>
					<dl class="ctl-list">
						<Binding label="Move" keys={['Left stick', 'D-pad']} />
						<Binding label="Action" keys={['A']} note="the bottom or left face button" />
						<Binding label="Cancel" keys={['B']} note="the right or top face, or either shoulder" />
						<Binding label="Menu" keys={['Start']} note="or Back" />
					</dl>
					<p class="ui-mute">
						A controller sends the same keys as the keyboard, so it follows whatever you set in SET KEYS. On a phone the
						touch controls step aside while a controller is connected.
					</p>
				</section>
			</div>
			<h3>Test</h3>
			{/* One block, so the lamps are in view under the two columns rather than a screen below them. */}
			<div class="ui-col">
				<p class="ui-status" id="ctl-status">
					{status()}
				</p>
				<div class="ctl-lamps">
					<For each={CONTROLS}>
						{([c, name]) => (
							<div class="ctl-lamp" classList={{ on: !!on[c] }} data-control={c}>
								<span class="ctl-lamp-name">{name}</span>
								<span class="ctl-lamp-key">{keyName(b.keys[c])}</span>
							</div>
						)}
					</For>
				</div>
				<p class="ctl-raw" id="ctl-last">
					{last()}
				</p>
				<p class="ctl-raw" id="ctl-raw">
					{raw()}
				</p>
				<p class="ui-mute">Presses stay in this panel: none of them starts the game.</p>
			</div>
		</Panel>
	);
}
