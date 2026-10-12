// ---- the archive ----
// Rooms that hardly count: menus, the debug room and Game Over
export const MENU_ROOMS = new Set([
	'RomInit',
	'RomStarter',
	'RomIntro0',
	'RomIntro1',
	'RomTitle',
	'RomLoad',
	'RomConfig',
	'RomTest',
	'RomGameover', // a dead end: it goes back to the title
]);
// Globals that churn: timers, scratch variables, cursors
export const STATIC_VOLATILE = [
	'rendrate',
	'rendt',
	'rd',
	'startingTime',
	'seconds',
	'minutes',
	'hours',
	'did_action',
	'shake',
	'deltaTime',
	'temp',
	'temp2',
	'tempx',
	'tempy',
	'cvx',
	'cvy',
	'roomer',
	'lastname',
	'skip',
	'skipper',
	'selected',
	'selectedt',
	'tcou',
	'lookdir',
	'camera',
	'sprinter',
];
export const VOLATILE_AFTER = 12; // values one global (or one array element) may take before the global counts as volatile
export const STORY =
	/^(plot|treasure|party|scheme|aswitch|char_xp|char_eskill|item_id|item_amount|following|fogtimes|firstshen|victorian|croom)(\[|=|$)/;
export const shortFn = (f) =>
	f
		.replace(/^gml_Script_/, '')
		.replace(
			/^gml_Object_(\w+?)_(Create|Destroy|Alarm|Step|Collision|Keyboard|Other|Draw|KeyPress|KeyRelease|Mouse|Trigger|CleanUp|PreCreate)_/,
			'$1.$2_',
		)
		.replace(/^gml_Room_/, 'room:');

export function storyFlags(globals) {
	const out = new Map();
	for (const [name, v] of Object.entries(globals)) {
		if (!STORY.test(name)) continue;
		if (!Array.isArray(v)) out.set(name, v);
		else
			for (const [i, x] of v.entries())
				if (Array.isArray(x)) for (const [j, y] of x.entries()) out.set(`${name}[${i}][${j}]`, y);
				else out.set(`${name}[${i}]`, x);
	}
	return out;
}
