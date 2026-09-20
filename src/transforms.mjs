// AST transforms over the unpacked code tree, applied in order. Each is (src, file) => src.
// Extraction transforms (cinema, objectAdd) run first so the code they pull out of
// strings also goes through the rewrites that follow.
import { parse, walk, applyEdits, isCall } from './lib/gml.mjs';

const at = (n, text) => ({ start: n.start, end: n.end, text });
const inBlock = (p) => p.type === 'Block' || p.type === 'Switch';
// Deletes a statement; a statement that is the body of if/with/etc. becomes {}.
const remove = (src, n, p) => {
  if (!inBlock(p)) return at(n, '{}');
  const end = /^[ \t]*\n?/.exec(src.slice(n.end))[0].length + n.end;
  return { start: n.start, end, text: '' };
};

function rewrite(src, visit) {
  const edits = [];
  walk(parse(src), (n, p) => {
    const e = visit(n, p);
    if (e) edits.push(...[e].flat());
  });
  return applyEdits(src, edits);
}

// ctx.addFile(path, code) creates a file in the code tree; ctx.warn(msg) reports something to review;
// ctx.mode is 'faithful' or 'modernized'; ctx.objects is the set of object names; ctx.placed maps an object to its
// room instances ([room, instance name, has creation code]); ctx.hasCreate(object) says if it has a Create event.
export function transforms(ctx) {
  const cinemaScripts = new Map();
  const fxCount = {};
  let ccTargets = null;

  return {
    // sCinema(obj,'code'|'cond',"<gml>") strings become scripts; oCinema runs them with script_execute.
    cinema(src) {
      return rewrite(src, (n) => {
        if (isCall(n, 'execute_string') && n.args[0] && src.slice(n.args[0].start, n.args[0].end) === 'queue[0,2]')
          return at(n.callee, 'script_execute');
        if (!isCall(n) || !/^sCinema\d*$/.test(n.callee.name)) return;
        const [, cmd, code] = n.args;
        if (cmd?.type !== 'String' || !/^(code|cond)$/.test(cmd.value)) return;
        if (code?.type !== 'String') return ctx.warn(`non-literal cinema ${cmd.value}: ${src.slice(n.start, n.end)}`);
        if (!cinemaScripts.has(code.value)) {
          const name = `cin_${String(cinemaScripts.size + 1).padStart(4, '0')}`;
          cinemaScripts.set(code.value, name);
          ctx.addFile(`scripts/${name}.gml`, `//${cmd.value}\n${code.value}`);
        }
        return at(code, cinemaScripts.get(code.value));
      });
    },

    // tob=object_add(); object_event_add(tob,ev_*,n,"<gml>") builds real objects named <owner>Fx<i>.
    objectAdd(src, file) {
      const owner = file.split('/')[1].replace(/\.gml$/, '');
      const created = new Map();
      const EVENT = { ev_create: 0, ev_destroy: 1, ev_alarm: 2, ev_step: 3, ev_draw: 8 };
      return rewrite(src, (n, p) => {
        if (n.type === 'Assign' && isCall(n.value, 'object_add')) {
          const name = `${owner}Fx${(fxCount[owner] = (fxCount[owner] ?? -1) + 1)}`;
          created.set(src.slice(n.target.start, n.target.end), name);
          return at(n.value, name);
        }
        if (n.type !== 'ExprStmt' || !isCall(n.expr, 'object_event_add')) return;
        const [obj, ev, num, code] = n.expr.args;
        const name = created.get(src.slice(obj.start, obj.end));
        if (!name || !(ev.name in EVENT) || num.type !== 'Number' || code.type !== 'String')
          return ctx.warn(`${file}: unhandled ${src.slice(n.start, n.end)}`);
        ctx.addFile(`objects/${name}/${EVENT[ev.name]}_${num.value}.gml`, code.value.trim() + '\n');
        return remove(src, n, p);
      });
    },

    // The lowercase beat-timing script `sa` was lost to a case collision with `sA`; it is restored as sBeatAdd.
    renameSa(src) {
      return rewrite(src, (n) => isCall(n, 'sa') && at(n.callee, 'sBeatAdd'));
    },

    // image_single=N  ->  image_index=N; image_speed=0;   (image_single=-1 resumes animation)
    imageSingle(src) {
      const targets = new Set();
      return rewrite(src, (n, p) => {
        if (n.type === 'Assign' && (n.target.name ?? n.target.prop?.name) === 'image_single') {
          const id = n.target.prop ?? n.target;
          targets.add(id);
          const obj = src.slice(n.target.start, id.start);
          const [open, close] = inBlock(p) ? ['', ''] : ['{ ', ' }'];
          if (n.op === '=' && src.slice(n.value.start, n.value.end).replace(/\s/g, '') === '-1')
            return at(n, `${open}${obj}image_speed=1;${close}`);
          const semi = src[n.end - 1] === ';' ? '' : ';';
          return [
            { start: n.start, end: id.end, text: `${open}${obj}image_index` },
            { start: n.end, end: n.end, text: `${semi} ${obj}image_speed=0;${close}` },
          ];
        }
        if (n.type === 'Identifier' && n.name === 'image_single' && !targets.has(n)) return at(n, 'image_index');
      });
    },

    // The LTS importer can't parse a parenthesised statement as an if/repeat/with body, e.g.
    // `if (c) (instance_create(...)).target=t;`, and then skips converting the whole file.
    parenStatements(src) {
      return rewrite(src, (n, p) => {
        if (n.type !== 'Assign' || inBlock(p) || p.type === 'Var' || p.type === 'For') return;
        let head = n.target;
        while (head.type === 'Member' || head.type === 'Index') head = head.object;
        if (head.type !== 'Paren') return;
        return [
          { start: n.start, end: head.end, text: `{ var __p; __p=${src.slice(head.expr.start, head.expr.end)}; __p` },
          { start: n.end, end: n.end, text: ' }' },
        ];
      });
    },

    // Names that are reserved words in modern GML (oBZomballer has a variable called `throw`).
    reservedWords(src) {
      const RESERVED = new Set([
        'throw',
        'try',
        'catch',
        'finally',
        'new',
        'delete',
        'function',
        'static',
        'constructor',
      ]);
      return rewrite(src, (n) => n.type === 'Identifier' && RESERVED.has(n.name) && at(n, `${n.name}_`));
    },

    // Legacy sound_* calls -> audio_*.
    sound(src) {
      const CALLS = {
        sound_play: ['audio_play_sound', ', 0, false'],
        sound_loop: ['audio_play_sound', ', 0, true'],
        sound_stop: ['audio_stop_sound', ''],
        sound_stop_all: ['audio_stop_all', ''],
        sound_isplaying: ['audio_is_playing', ''],
        sound_volume: ['audio_sound_gain', ', 0'],
      };
      return rewrite(src, (n, p) => {
        if (n.type === 'ExprStmt' && /^sound_(restore|delete)$/.test(n.expr.callee?.name)) return remove(src, n, p);
        if (!isCall(n) || !(n.callee.name in CALLS)) return;
        const [name, extra] = CALLS[n.callee.name];
        return [at(n.callee, name), { start: n.end - 1, end: n.end - 1, text: extra }];
      });
    },

    // Legacy functions that the importer leaves alone and LTS doesn't have. object_delete freed object_add
    // objects, which are real objects now (some calls even pass an instance), so it is dropped.
    legacyCalls(src) {
      return rewrite(src, (n, p) => {
        if (n.type === 'ExprStmt' && isCall(n.expr, 'object_delete')) return remove(src, n, p);
        if (isCall(n, 'make_color')) return at(n.callee, 'make_color_rgb');
        if (isCall(n, 'variable_local_exists'))
          return [
            at(n.callee, 'variable_instance_exists'),
            { start: n.args[0].start, end: n.args[0].start, text: 'id, ' },
          ];
      });
    },

    // GM 1.4 drew numbers as text; the importer wraps every drawn or measured text in string_hash_to_newline(),
    // which on HTML5 throws for a number ("substring is not a function"), e.g. oDamage's damage numbers. The text
    // argument goes through string() unless it's plainly a string already.
    drawTextStrings(src) {
      const TEXT_ARG = {
        draw_text: 2,
        draw_text_ext: 2,
        draw_text_color: 2,
        draw_text_ext_color: 2,
        draw_text_transformed: 2,
        draw_text_ext_transformed: 2,
        string_width: 0,
        string_height: 0,
        string_width_ext: 0,
        string_height_ext: 0,
      };
      const isString = (e) =>
        e.type === 'String' ||
        (isCall(e) &&
          /^string(_|$)/.test(e.callee.name) &&
          !/^string_(width|height|pos|count|length)/.test(e.callee.name)) ||
        (e.type === 'Binary' && e.op === '+' && (isString(e.left) || isString(e.right)));
      return rewrite(src, (n) => {
        const a = isCall(n) && n.args[TEXT_ARG[n.callee.name]];
        if (!a || !(n.callee.name in TEXT_ARG) || isString(a)) return;
        return [
          { start: a.start, end: a.start, text: 'string(' },
          { start: a.end, end: a.end, text: ')' },
        ];
      });
    },

    // GM6's real() gave 0 for a string with no number in it; LTS throws. The game reads item amounts with
    // real(string_digits(name)), and names without digits (" Revive") crashed item use.
    gm6Real(src) {
      return rewrite(
        src,
        (n) =>
          isCall(n, 'real') &&
          isCall(n.args[0], 'string_digits') && { start: n.args[0].start, end: n.args[0].start, text: '"0"+' },
      );
    },

    // GM6's obj.var=v set var on every obj instance, so with none it did nothing; LTS ends the game ("Unable to find
    // any instance for object index"), e.g. oIntro5's oSoldier4.t=1 in RomNeoYork1, which has no oSoldier4. Every
    // such statement becomes {if (instance_exists(obj)) obj.var=v;}. (Reads through a missing object failed in GM6 too.)
    noInstanceAssign(src) {
      return rewrite(src, (n, p) => {
        const o = n.type === 'Assign' && n.target.type === 'Member' && n.target.object;
        if (!o || o.type !== 'Identifier' || !ctx.objects.has(o.name)) return;
        if (!(inBlock(p) || [p.consequent, p.alternate, p.body].includes(n))) return; // not a for header
        // the statement's own ; (inside the node or right after it) goes inside the braces: `if (a) {…}; else` is wrong
        const semi = src[n.end - 1] === ';' ? 0 : (/^[ \t]*;/.exec(src.slice(n.end))?.[0].length ?? -1);
        // one edit for the whole statement: a closing } and the next statement's {if at the same offset would swap
        const end = n.end + Math.max(semi, 0);
        return {
          start: n.start,
          end,
          text: `{if (instance_exists(${o.name})) ${src.slice(n.start, n.end)}${semi ? ';' : ''}}`,
        };
      });
    },

    // GM6 ran a room instance's creation code before its Create event; LTS runs it after. oColliderGuy's Create reads
    // group and moves from its creation code (sGroup), oMusic's reads val, the treasures' read val, and oExit239's
    // Create sets solid after its creation code did. For each object with a Create event and a placed instance with
    // creation code, its placed instances skip Create until their creation code (which every one of them gets) has run
    // and performs it. Created instances (ids from 1000000; placed ones keep their room ids from 100000) are unchanged.
    creationCodeFirst(src, file) {
      let targets = ccTargets;
      if (!targets) {
        targets = ccTargets = new Set(
          [...ctx.placed].filter(([o, list]) => ctx.hasCreate(o) && list.some((i) => i[2])).map(([o]) => o),
        );
        for (const o of targets)
          for (const [room, inst, has] of ctx.placed.get(o))
            if (!has) ctx.addFile(`rooms/${room}/${inst}.gml`, '__gm6cc=1; event_perform(ev_create, 0);\n');
      }
      let m = /^rooms\/([^/]+)\/([^/]+)\.gml$/.exec(file);
      if (m && m[2] !== 'creation') {
        const o = [...targets].find((o) => ctx.placed.get(o).some(([r, i, has]) => has && r === m[1] && i === m[2]));
        return o ? `${src.replace(/\n?$/, '\n')}__gm6cc=1; event_perform(ev_create, 0);\n` : src;
      }
      m = /^objects\/([^/]+)\/0_0\.gml$/.exec(file);
      if (m && targets.has(m[1]))
        return `if (object_index=${m[1]} && id<1000000 && !variable_instance_exists(id, '__gm6cc')) exit; //GM6: creation code first\n${src}`;
      return src;
    },

    // Modernized only: keyboard reads and clears go through key_check/key_clear (patch modernized/03), so a cleared
    // key stays up until it is released, as in GM6. The latch scripts themselves read the runtime state.
    keyLatch(src, file) {
      if (ctx.mode !== 'modernized' || /^scripts\/key_(check|clear|release)\.gml$/.test(file)) return src;
      const CALLS = { keyboard_check: 'key_check', keyboard_check_direct: 'key_check', keyboard_clear: 'key_clear' };
      return rewrite(src, (n) => isCall(n) && n.callee.name in CALLS && at(n.callee, CALLS[n.callee.name]));
    },

    // GM6 reads arguments a call didn't pass as 0; LTS makes them undefined, e.g. sFont(font,color,halign)
    // then crashes in draw_set_valign(argument3). Each script defaults the argumentN it reads. The check is
    // is_undefined, not argument_count: on HTML5 argument_count is never below a function's named parameters.
    argumentDefaults(src, file) {
      if (!file.startsWith('scripts/')) return src;
      let count = 0;
      walk(parse(src), (n) => {
        const m = n.type === 'Identifier' && /^argument(\d+)$/.exec(n.name);
        if (m) count = Math.max(count, +m[1] + 1);
      });
      if (!count) return src;
      const defaults = Array.from({ length: count }, (_, i) => `if (is_undefined(argument${i})) argument${i}=0;`);
      return `${defaults.join(' ')}\n${src}`;
    },

    // Modernized only, for resume (patch modernized/06), which rebuilds the game after the tab reloads. While it does,
    // Create events and instance creation code (resume_skip(0)) and Room Start events (resume_skip(1)) exit, so the saved
    // room's placed instances and the restored ones run nothing the saved game hadn't already run. Sounds play through
    // resume_play, which keeps their handles so resume_save can read their position.
    resume(src, file) {
      if (ctx.mode !== 'modernized') return src;
      if (file !== 'scripts/resume_play.gml')
        src = rewrite(src, (n) => isCall(n, 'audio_play_sound') && at(n.callee, 'resume_play'));
      const kind = /^rooms\/|^objects\/[^/]+\/0_0(_\d+)?\.gml$/.test(file)
        ? 0
        : /^objects\/[^/]+\/7_4(_\d+)?\.gml$/.test(file)
          ? 1
          : -1;
      return kind < 0 ? src : `if (resume_skip(${kind})) exit;\n${src}`;
    },
  };
}
