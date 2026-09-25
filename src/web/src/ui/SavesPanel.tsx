// Configuration -> SETTINGS -> Saves: every save slot in this browser as one block of text to copy or download, and
// a box to paste one back (extensions/saves.ts has the format).
import { createSignal } from 'solid-js';
import { importSaves, saves, setSaves, setSavesOpen } from '../extensions/saves';
import { copy, Panel } from './Panel';

export function SavesPanel() {
	let out!: HTMLTextAreaElement, inp!: HTMLTextAreaElement, file!: HTMLInputElement;
	const [copied, setCopied] = createSignal(false);
	const download = () => {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([saves.code], { type: 'text/plain' }));
		a.download = `barkley-saves-${new Date().toISOString().slice(0, 10)}.txt`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10000);
	};
	const open = () => {
		const f = file.files?.[0];
		if (f)
			f.text().then((t) => {
				inp.value = t;
				setSaves('status', `Opened ${f.name}. Press Import to write it into this browser.`);
			});
	};
	return (
		<Panel id="saves-panel" title="Saves" onClose={() => setSavesOpen(0)}>
			<p class="ui-mute">
				Saves live in this browser only. Copy the code to take your game to another browser or device, or to keep it
				safe before clearing site data. Keys, screen and volume stay on each device.
			</p>
			<p class="ui-status">{saves.status}</p>
			<div class="ui-cols">
				<section class="ui-col">
					<h3>Export</h3>
					<textarea class="ui-code" ref={out} readOnly aria-label="Save code from this browser" value={saves.code} />
					<div class="ui-row">
						<button
							type="button"
							class="ui-btn primary"
							disabled={!saves.code}
							onClick={() => copy(out, out.value, () => setCopied(true))}
						>
							{copied() ? 'Copied' : 'Copy'}
						</button>
						<button type="button" class="ui-btn" disabled={!saves.code} onClick={download}>
							Download
						</button>
					</div>
				</section>
				<section class="ui-col">
					<h3>Import</h3>
					<textarea class="ui-code" ref={inp} placeholder="Paste a save code here" aria-label="Save code to import" />
					<div class="ui-row">
						<button type="button" class="ui-btn primary" onClick={() => importSaves(inp.value)}>
							Import
						</button>
						<button type="button" class="ui-btn" onClick={() => file.click()}>
							Open file…
						</button>
						<input type="file" ref={file} accept="text/plain,.txt" hidden onChange={open} />
					</div>
				</section>
			</div>
		</Panel>
	);
}
