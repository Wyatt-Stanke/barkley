// A crash report (extensions/crash.ts) to copy and send: after an uncaught error, when the game has stopped, or when
// the player typed BUG, with the game still running behind it.
import { createSignal, Show } from 'solid-js';
import { setCrashReport } from '../extensions/crash';
import { copy, Panel } from './Panel';

export function CrashPanel(props: { kind: 'crash' | 'report'; text: string }) {
	let area!: HTMLTextAreaElement;
	const [copied, setCopied] = createSignal(false);
	const crash = props.kind === 'crash';
	return (
		<Panel
			id="crash-report"
			title={crash ? 'The game stopped' : 'Bug report'}
			onClose={crash ? undefined : () => setCrashReport(null)}
		>
			<p class="ui-mute">
				Copy this report and send it with a few words about what you were doing.
				{crash ? ' Then reload the page to play on.' : ''}
			</p>
			<textarea class="ui-code" ref={area} readOnly value={props.text} aria-label="Report" />
			<div class="ui-row">
				<button type="button" class="ui-btn primary" onClick={() => copy(area, props.text, () => setCopied(true))}>
					{copied() ? 'Copied' : 'Copy report'}
				</button>
				<Show when={crash}>
					<button type="button" class="ui-btn" onClick={() => location.reload()}>
						Reload
					</button>
				</Show>
			</div>
		</Panel>
	);
}
