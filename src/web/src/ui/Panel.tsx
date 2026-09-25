// A panel over the game or the Start screen (install, Controls, Saves, crash report): a black sheet, a title and its
// hairline, then its content. Keys pressed in a panel stay in it: the game cancels every key it sees, and the Start
// screen would start on one. A release of a key pressed before the panel opened (the G of BUG, the key that chose
// Saves) still gets through, or the game would go on holding that key down.
import { type JSX, onMount, Show } from 'solid-js';
import './Panel.css';

export function Panel(props: {
	id: string;
	title: string;
	// Close link and Esc; without it the panel stays until something else removes it
	onClose?: () => void;
	onKeyDown?: (e: KeyboardEvent) => void;
	onKeyUp?: (e: KeyboardEvent) => void;
	children: JSX.Element;
}) {
	let box!: HTMLDivElement;
	const down = new Set<string>();
	onMount(() => box.focus());
	return (
		<div
			id={props.id}
			ref={box}
			class="ui-panel"
			tabIndex={-1}
			role="dialog"
			aria-labelledby={`${props.id}-title`}
			on:keydown={(e) => {
				e.stopPropagation();
				down.add(e.code);
				if (e.key === 'Escape' && props.onClose) return props.onClose();
				props.onKeyDown?.(e);
			}}
			on:keyup={(e) => {
				if (down.delete(e.code)) e.stopPropagation();
				props.onKeyUp?.(e);
			}}
		>
			<div class="ui-head">
				<h2 id={`${props.id}-title`}>{props.title}</h2>
				<Show when={props.onClose}>
					{(close) => (
						<button type="button" class="ui-link" onClick={() => close()()}>
							Close
						</button>
					)}
				</Show>
			</div>
			{props.children}
		</div>
	);
}

// Copies text, and says so on the button that asked (execCommand for a browser without the clipboard API)
export function copy(area: HTMLTextAreaElement, text: string, done: () => void) {
	area.select();
	if (navigator.clipboard)
		navigator.clipboard.writeText(text).then(done, () => {
			if (document.execCommand('copy')) done();
		});
	else if (document.execCommand('copy')) done();
}
