// The first visit from a phone or tablet in a browser tab: install the game as an app, which opens full screen.
// iOS gets Safari's steps and a note that its home-screen app keeps its own storage; others get the browser menu's,
// and Chrome's own install dialog behind an Install button when Chrome offers it.
import { Show } from 'solid-js';
import { installPrompt, ios, setInstallOpen } from '../install';
import { Panel } from './Panel';
import './InstallPrompt.css';

const Share = () => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="square"
		aria-hidden="true"
	>
		<path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" />
	</svg>
);

export function InstallPrompt() {
	const install = (e: BeforeInstallPromptEvent) =>
		e
			.prompt()
			.then(() => e.userChoice)
			.then((r) => r.outcome === 'accepted' && setInstallOpen(false));
	return (
		<Panel id="install" title="Play full screen">
			<p>Barkley plays best as an app: full screen, without the address bar, from your home screen.</p>
			<ol class="ui-steps" id="install-how">
				<Show
					when={ios}
					fallback={
						<>
							<li>
								<span>
									Open the browser menu, <b>&#8942;</b>.
								</span>
							</li>
							<li>
								<span>
									Tap <b>Install app</b> or <b>Add to Home screen</b>.
								</span>
							</li>
						</>
					}
				>
					<li>
						<span>
							Tap <b>Share</b> <Share /> in Safari's toolbar, or under <b>&middot;&middot;&middot;</b>.
						</span>
					</li>
					<li>
						<span>
							Tap <b>Add to Home Screen</b>.
						</span>
					</li>
				</Show>
				<li>
					<span>Open Barkley from your home screen.</span>
				</li>
			</ol>
			<Show when={ios}>
				{/* Home-screen apps on iOS keep their own storage, apart from Safari's. */}
				<p class="ui-mute" id="install-note">
					The app keeps its own saves, separate from Safari's. To bring saves along, use Configuration → SETTINGS →
					Saves in both.
				</p>
			</Show>
			<div class="ui-foot">
				<Show when={installPrompt()}>
					{(e) => (
						<button type="button" class="ui-btn primary" id="install-now" onClick={() => install(e())}>
							Install
						</button>
					)}
				</Show>
				<button type="button" class="ui-btn" id="install-skip" onClick={() => setInstallOpen(false)}>
					Continue in browser
				</button>
			</div>
		</Panel>
	);
}
