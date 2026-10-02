import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { frameCount } from './programs.mjs';
import { MENU_ROOMS, shortFn } from './story.mjs';
import { blue, cyan, dim, dur, green, magenta, red, tty, yellow } from './util.mjs';

// What the run says: the episode lines, the status box, summary.md, crash reports and the verify verdict.
export const report = {
	say(line) {
		if (this.opts.verbose || !/^\s*$/.test(line)) console.log(line);
	},

	// A line per episode for --verbose
	episodeLine(w, from, _program, res, news) {
		const p = from.probe;
		const bars = '▁▂▃▄▅▆▇█';
		const bar = bars[Math.min(7, Math.floor((res.frames / 1250) * 8))];
		const where = `${cyan(p.room.replace(/^Rom/, ''))}${dim('·')}${yellow(`p${p.plot}`)}`;
		const parts = [
			dim(`w${String(w.b.id).padStart(2, '0')}`),
			where.padEnd(tty ? 42 : 24),
			dim(`${bar} ${String(res.frames).padStart(4)}f`),
		];
		const list = (a, f, n) => a.slice(0, n).map(f).join(' ') + (a.length > n ? dim(` +${a.length - n}`) : '');
		if (news.cells.length)
			parts.push(
				green(`◆${news.cells.length}`) +
					' ' +
					green(list(news.cells, (c) => `${c.split('|').slice(0, 2).join('·')}@${c.split('|')[3]}`, 1)),
			);
		if (news.fns.length) parts.push(magenta(`ƒ ${list(news.fns, shortFn, 3)}`));
		if (news.flags.length) parts.push(blue(`⚑ ${list(news.flags, (f) => f, 3)}`));
		if (res.crash)
			parts.push(
				res.crash.kind === 'restore'
					? yellow(`↺ ${res.crash.message.slice(0, 60)}`)
					: red(`✖ #${news.crash.n} ${res.crash.message.split('\n')[0].slice(0, 70)}`),
			);
		if (res.ended) parts.push(dim('(game ended)'));
		if (parts.length === 3) parts.push(dim('·'));
		console.log(parts.join('  '));
	},

	status() {
		const s = this.stats;
		const t = Date.now() - s.t0;
		const kinds = { c: 0, v: 0, f: 0 };
		for (const k of this.features.keys()) kinds[k[0]] = (kinds[k[0]] ?? 0) + 1;
		const fps = s.frames / (t / 1000);
		const furthest = [...this.nodes.values()]
			.filter((n) => n.snap && !MENU_ROOMS.has(n.probe.room))
			.sort((a, b) => b.progress - a.progress)[0];
		const lines = [
			`${dur(t)}, ${this.workers.length} workers: ${s.episodes} episodes (${(s.episodes / (t / 1000)).toFixed(1)}/s), ${s.frames} frames (${fps.toFixed(0)}/s, ${(fps / 60).toFixed(0)}x real time, ${(s.frames / 216000).toFixed(1)} h of play), ${s.restarts} browser restarts`,
			`archive: ${this.nodes.size} nodes; features: ${kinds.c} cells, ${kinds.v} room×function, ${kinds.f} flags; ${this.volatile.size} volatile globals`,
			`furthest: ${furthest ? `${furthest.probe.room} plot ${furthest.probe.plot}, ${furthest.rooms.length} rooms on its path, ${(furthest.frames / 60).toFixed(0)} s of play` : '-'}`,
			`play by plot started from: ${Object.entries(s.byPlot ?? {})
				.map(([p, f]) => `${p} ${((100 * f) / Math.max(1, s.frames)).toFixed(0)}%`)
				.join(', ')}; strongest party: ${(() => {
				const n = [...this.nodes.values()]
					.filter((n) => n.snap)
					.sort((a, b) => (b.probe.xp ?? 0) - (a.probe.xp ?? 0))[0];
				return n?.probe.xp !== undefined
					? `levels ${n.probe.lv}${n.probe.fudge ? ` (${n.probe.fudge} fudged)` : ''}, ${n.probe.xp} xp (${n.probe.room} plot ${n.probe.plot})`
					: '-';
			})()}; best boss fight: ${(() => {
				const n = [...this.nodes.values()]
					.filter((n) => n.snap && this.fightScore(n.probe) > 0)
					.sort((a, b) => this.fightScore(b.probe) - this.fightScore(a.probe))[0];
				return n
					? `${n.probe.foes} (plot ${n.probe.plot}, levels ${n.probe.lv}${n.probe.fudge ? `, ${n.probe.fudge} fudged` : ''})`
					: '-';
			})()}`,
			`story rooms ${this.storyRooms.size}: ${[...this.storyRooms].join(' ')}; ${this.exits.size} exits taken, ${this.talked.size} things talked to`,
			`found per 10k frames: ${Object.entries(this.genStats)
				.map(([g, v]) => `${g} ${((v.found * 10000) / Math.max(1, v.frames)).toFixed(1)}`)
				.join(', ')}`,
			// known crashes from earlier runs only when they came back
			`crashes ${this.crashes.size} (${[...this.crashes.values()].filter((e) => e.old).length} from earlier runs)${[
				...this.crashes.values(),
			]
				.filter((e) => !e.old || e.now)
				.map(
					(e) => `\n  #${e.n} x${e.count}${e.old ? ` (${e.now} this run)` : ''} ${e.sig}  [${e.verify ?? 'replaying'}]`,
				)
				.join('')}`,
			`findings: ${this.out}`,
		];
		writeFileSync(path.join(this.out, 'status.txt'), `${lines.join('\n')}\n`);
		this.summary(t, lines);
		return lines;
	},

	summary(t, lines) {
		const md = [
			`# Fuzz run ${path.basename(this.out)}`,
			'',
			`- Build: \`${this.root}\``,
			`- Started ${new Date(this.stats.t0).toISOString()}, ran ${dur(t)}${this.stopping ? ' (finished)' : ' (running)'}`,
			...lines.slice(0, 5).map((l) => `- ${l}`),
			this.opts.through ? '- Known crash classes patched (--through)' : '',
			this.opts.corpus ? `- Corpus: \`${this.opts.corpus}\`` : '',
			'',
			'## Crashes',
			'',
			'| # | seen | first after | signature | replay |',
			'|---|---|---|---|---|',
			...[...this.crashes.values()].map(
				(e) =>
					`| ${e.old ? (e.dir ? `[${e.n}](${e.dir}/report.md)` : e.n) : `[${e.n}](crashes/${e.n}/report.md)`} | ${e.count} | ${e.old ? 'an earlier run' : dur(e.first.at)} | \`${e.sig.replace(/\|/g, '\\|')}\` | ${e.verify ?? 'replaying'} |`,
			),
			'',
			'## Milestones',
			'',
			'| # | why | room | plot | after | play time | from a fresh page |',
			'|---|---|---|---|---|---|---|',
			...this.paths.map(
				(m) =>
					`| [${m.n}](paths/${path.basename(m.dir)}/report.md) | ${m.why} | ${m.node.probe.room} | ${m.node.probe.plot} | ${dur(m.at)} | ${(m.node.frames / 60).toFixed(0)} s | ${m.verify ?? 'replaying'} |`,
			),
			'',
			'Replay a finding with screenshots: `node fuzz/fuzz.mjs replay <build dir> <finding dir>`',
		];
		writeFileSync(path.join(this.out, 'summary.md'), `${md.join('\n')}\n`);
	},

	crashReport(e, chain) {
		const c = e.first;
		const gmlStack = c.stack
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => /gml_/.test(l) && !/<anonymous>/.test(l))
			.reduce((out, l) => {
				// the runtime's caller walk repeats a recursive frame; show it once
				const last = out.at(-1);
				if (last?.line === l) last.n++;
				else out.push({ line: l, n: 1 });
				return out;
			}, [])
			.map(({ line, n }) => (n > 1 ? `${line}  (×${n})` : line));
		const md = [
			`# Crash ${e.n}`,
			'',
			`\`${e.sig}\``,
			'',
			`- Kind: ${c.kind}; seen ${e.count} times; first after ${dur(c.at)} of fuzzing`,
			`- Where: ${JSON.stringify(c.probe)}`,
			`- Path: ${chain.length} steps from the new game, ${frameCount(chain.flatMap((s) => s.program))} frames (${(frameCount(chain.flatMap((s) => s.program)) / 60).toFixed(0)} s of play); the nearest snapshot is step ${e.snapAt}`,
			`- Replay: ${e.verify ?? 'not replayed yet'}`,
			e.bootProbe ? `- The fresh-page replay ended at ${JSON.stringify(e.bootProbe)}` : '',
			'',
			'## Message',
			'',
			'```',
			c.message,
			'```',
			'',
			'## GML stack',
			'',
			'```',
			...(gmlStack.length ? gmlStack : [c.stack]),
			'```',
			'',
			'Files: `crash.json` (the error and every input step from the new game), `snapshot.json.gz` (the game state at the',
			'nearest snapshot), `from-snapshot.png` and `from-boot.png` (the screen after each replay).',
			'',
			`Replay with screenshots: \`node fuzz/fuzz.mjs replay ${this.root} ${e.dir}\``,
		];
		writeFileSync(path.join(e.dir, 'report.md'), `${md.join('\n')}\n`);
	},

	// verify: whether the game still does what the corpus recorded, as markdown. It fails on a crash that replays (or
	// couldn't be replayed), new or one the corpus knew (a fixed bug come back); crashes that only happened after the
	// fuzzer's restores, paths that now lead elsewhere and places no replayed path reached are warnings, unless --strict.
	verdict() {
		const r = this.rebased ?? { targets: 0, exact: 0, moved: 0, drifted: [], crashed: [], failed: 0, skipped: 0 };
		const fresh = [...this.crashes.values()].filter((e) => !e.old);
		const harness = (e) => ['restore', 'stall', 'hang'].includes(e.first.kind);
		const real = (e) => !harness(e) && (!e.verify || /reproduced|replay failed/.test(e.verify));
		const failing = fresh.filter(real);
		const flaky = fresh.filter((e) => !failing.includes(e));
		const back = [...this.crashes.values()].filter((e) => e.old && e.now);
		const returned = back.filter(real);
		const again = back.filter((e) => !returned.includes(e));
		// rooms and plots the replayed corpus paths were recorded in that none of them reached this time
		const where = (p) => `${p.room} plot ${p.plot}`;
		const want = new Set(this.rebaseTargets?.filter((n) => !MENU_ROOMS.has(n.probe.room)).map((n) => where(n.probe)));
		const got = new Set(this.candidates.map((n) => where(n.probe)));
		const lost = [...want].filter((w) => !got.has(w));
		// the longest path from a fresh page: another room or plot (or no end at all) fails, another spot is a warning
		const f = this.fresh;
		const strict = this.opts.strict && (r.drifted.length || lost.length || r.failed || (f && !f.exact));
		const ok = !failing.length && !returned.length && !strict && (!f || f.room);
		const fpos = (p) => (p ? `${where(p)} at (${p.x},${p.y})${p.battle ? ' in a battle' : ''}` : 'nowhere');
		const s = this.stats;
		const md = [
			`## Fuzz verification: ${ok ? 'passed' : 'failed'}`,
			'',
			`- Build \`${path.basename(this.root)}\`; the corpus: ${this.nodes.size} nodes, ${this.pastMilestones} milestones, furthest plot ${this.maxPlot}`,
			`- Replayed ${r.targets} corpus paths (${this.opts.spine ? 'the furthest of each room and plot, and those on their way' : 'all of them'}): ` +
				`${r.exact} ended exactly where they were recorded, ${r.moved} in the same room elsewhere, ${r.drifted.length} went ` +
				`elsewhere, ${r.crashed.length} crashed, ${r.failed} failed to replay, ${r.skipped} skipped after those`,
			f
				? `- The longest (node ${f.id}, ${f.frames} frames) from a fresh page with no restores: ` +
					(f.exact
						? 'ended exactly where it was recorded'
						: `${f.room ? 'warning' : 'FAILED'}: ended ${f.error ? `nowhere (${f.error})` : f.crash ? `in a crash (${f.crash})` : fpos(f.got)}, recorded ${fpos(f.want)}`)
				: '',
			this.opts.minutes
				? `- Then explored for ${this.opts.minutes} min: ${s.episodes} episodes, ${(s.frames / 216000).toFixed(1)} h of play`
				: '',
			...(failing.length
				? ['', '### New crashes', '', ...failing.map((e) => `- \`${e.sig}\`: ${e.verify ?? 'not replayed'} (${e.dir})`)]
				: []),
			...(flaky.length
				? [
						'',
						'### New crashes that did not replay (warnings)',
						'',
						...flaky.map((e) => `- \`${e.sig}\`: ${e.verify ?? 'not replayed'}`),
					]
				: []),
			...(returned.length
				? [
						'',
						'### Known crashes that came back',
						'',
						...returned.map((e) => `- \`${e.sig}\` (${e.now}×): ${e.verify ?? 'not replayed'} (${e.dir})`),
					]
				: []),
			...(again.length
				? [
						'',
						'### Known crashes seen again that did not replay (warnings)',
						'',
						...again.map((e) => `- \`${e.sig}\` (${e.now}×): ${e.verify ?? 'not replayed'}`),
					]
				: []),
			...(r.drifted.length
				? [
						'',
						`### Paths that went elsewhere (${r.drifted.length})`,
						'',
						...r.drifted.slice(0, 20).map((d) => `- node ${d.id}: recorded in ${where(d.want)}, now ${where(d.got)}`),
					]
				: []),
			...(lost.length ? ['', '### Places no replayed path reached', '', ...lost.map((w) => `- ${w}`)] : []),
			'',
			`Findings: \`${this.out}\``,
		].filter((l, i, a) => l !== '' || a[i - 1] !== '');
		writeFileSync(path.join(this.out, 'verify.md'), `${md.join('\n')}\n`);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
		console.log(`\n${md.join('\n')}`);
		return ok;
	},
};
