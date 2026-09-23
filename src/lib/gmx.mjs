// Unpacks the GML embedded in a GameMaker: Studio 1.4 GMX project into a tree of plain
// .gml files (LF line endings), and packs it back. Layout of the code tree:
//   scripts/<name>.gml
//   objects/<object>/<eventtype>_<enumb|ename>[_<action>].gml
//   rooms/<room>/creation.gml, rooms/<room>/<instance name>.gml
// Packing also syncs project resources: scripts added/removed in the tree are
// registered/unregistered, and new object folders become new objects.
import fs from 'node:fs';
import path from 'node:path';

// Numeric references too: GameMaker writes &#xA; for a newline inside an attribute, but any
// other XML writer is free to spell the same characters its own way (&#13; for the CR of a
// CRLF, say), and this has to read whatever wrote the file.
const unesc = (s) =>
  s.replace(/&(lt|gt|quot|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) =>
    e[0] === '#'
      ? String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : { lt: '<', gt: '>', quot: '"', amp: '&' }[e],
  );
const esc = (s, attr) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/"/g, attr ? '&quot;' : '"');
const toLF = (s) => s.replace(/\r\n/g, '\n');
const toCRLF = (s) => s.replace(/\r?\n/g, '\r\n');
// Attributes are matched by name, not by position: the order they are written in is not
// part of what an XML document says, and GameMaker's order is not the only one in use.
const EVENT = /(<event\s([^>]*)>)([\s\S]*?)(<\/event>)/g;
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const ACTION = /<action>[\s\S]*?<\/action>/g;
const CODE_STRING = /(<string>)([\s\S]*?)(<\/string>)/;
const INSTANCE = /<instance\s[^>]*>/g;
const INSTANCE_CODE = /(\scode=")([^"]*)(")/;
const ROOM_CODE = /(<code>)([\s\S]*?)(<\/code>)/;

const projectFile = (dir) =>
  path.join(
    dir,
    fs.readdirSync(dir).find((f) => f.endsWith('.project.gmx')),
  );
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

// Visits every embedded code string in an object/room XML file. fn(key, code) returns
// the replacement code, or undefined to keep it. Unchanged code keeps its original bytes.
const swap = (raw, key, fn, attr) => {
  const old = toLF(unesc(raw)),
    code = fn(key, old);
  return code === undefined || toLF(code) === old ? raw : esc(toCRLF(code), attr);
};

function mapObject(xml, fn) {
  return xml.replace(EVENT, (all, open, attrs, body, close) => {
    const type = attr(attrs, 'eventtype'),
      num = attr(attrs, 'enumb') ?? attr(attrs, 'ename');
    let j = 0;
    body = body.replace(ACTION, (action) => {
      if (!action.includes('<id>603</id>')) return action;
      const key = `${type}_${num}${j ? `_${j}` : ''}`;
      j++;
      return action.replace(CODE_STRING, (m, a, code, b) => a + swap(code, key, fn) + b);
    });
    return open + body + close;
  });
}

function mapRoom(xml, fn) {
  xml = xml.replace(ROOM_CODE, (m, a, code, b) => a + swap(code, 'creation', fn) + b);
  // (an instance with no code has no file when unpacked; packing gives it the code of a file a transform added)
  return xml.replace(INSTANCE, (tag) => {
    const name = attr(tag, 'name');
    if (name === undefined) return tag;
    return tag.replace(INSTANCE_CODE, (m, a, code, b) => a + swap(code, name, fn, true) + b);
  });
}

const listResources = (proj, tag) =>
  [...proj.matchAll(new RegExp(`<${tag}>(?:\\w+\\\\)+([^<]+)</${tag}>`, 'g'))].map((m) => m[1]);

export function unpack(projectDir, codeDir) {
  const proj = read(projectFile(projectDir));
  for (const f of fs.readdirSync(path.join(projectDir, 'scripts')).filter((f) => f.endsWith('.gml')))
    write(path.join(codeDir, 'scripts', f), toLF(read(path.join(projectDir, 'scripts', f))));
  for (const [kind, map] of [
    ['object', mapObject],
    ['room', mapRoom],
  ]) {
    for (const name of listResources(proj, kind)) {
      map(read(path.join(projectDir, `${kind}s`, `${name}.${kind}.gmx`)), (key, code) => {
        if (code) write(path.join(codeDir, `${kind}s`, name, `${key}.gml`), code);
      });
    }
  }
}

export function pack(codeDir, projectDir) {
  const pf = projectFile(projectDir);
  let proj = read(pf);
  const codeFile = (...p) => path.join(codeDir, ...p);
  const readCode = (...p) => (fs.existsSync(codeFile(...p)) ? read(codeFile(...p)) : '');

  // Scripts: the code tree is the source of truth.
  const scripts = fs
    .readdirSync(codeFile('scripts'))
    .filter((f) => f.endsWith('.gml'))
    .map((f) => f.slice(0, -4));
  const keep = new Set(scripts);
  proj = proj.replace(/^\s*<script>scripts\\([^<]+)\.gml<\/script>\r?\n/gm, (m, n) => (keep.delete(n) ? m : ''));
  proj = insertResources(
    proj,
    'script',
    [...keep].map((n) => `scripts\\${n}.gml`),
  );
  const onDisk = new Map(
    fs
      .readdirSync(path.join(projectDir, 'scripts'))
      .filter((f) => f.endsWith('.gml'))
      .map((f) => [f, read(path.join(projectDir, 'scripts', f))]),
  );
  for (const f of onDisk.keys()) if (!scripts.includes(f.slice(0, -4))) fs.rmSync(path.join(projectDir, 'scripts', f));
  for (const n of scripts) {
    const code = readCode('scripts', `${n}.gml`),
      old = onDisk.get(`${n}.gml`);
    if (old === undefined || toLF(old) !== code) write(path.join(projectDir, 'scripts', `${n}.gml`), toCRLF(code));
  }

  // Objects and rooms: write code back into existing XML; new object folders become objects.
  const known = new Set(listResources(proj, 'object'));
  const added = fs.readdirSync(codeFile('objects')).filter((n) => !known.has(n));
  for (const n of added)
    write(path.join(projectDir, 'objects', `${n}.object.gmx`), newObjectXml(fs.readdirSync(codeFile('objects', n))));
  proj = insertResources(
    proj,
    'object',
    added.map((n) => `objects\\${n}`),
  );
  for (const [kind, map] of [
    ['object', mapObject],
    ['room', mapRoom],
  ]) {
    for (const name of listResources(proj, kind)) {
      const f = path.join(projectDir, `${kind}s`, `${name}.${kind}.gmx`);
      write(
        f,
        map(read(f), (key) => readCode(`${kind}s`, name, `${key}.gml`)),
      );
    }
  }
  write(pf, proj);
}

function insertResources(proj, tag, entries) {
  if (!entries.length) return proj;
  // Follow the file's own line ending and indentation. GameMaker writes CRLF and two spaces a
  // level; another writer may not, and an indexOf for CRLF that misses returns -1, which splices
  // the new entries in one character from the end of the document.
  const m = new RegExp(`(\\r?\\n)([ \\t]*)</${tag}s>`).exec(proj);
  if (!m) throw new Error(`no </${tag}s> in the project file`);
  const open = `${m[1]}${m[2]}  <${tag}>`;
  return proj.slice(0, m.index) + entries.map((e) => `${open}${e}</${tag}>`).join('') + proj.slice(m.index);
}

// A bare object whose events each run one code action. Event files are named <eventtype>_<enumb>.gml.
function newObjectXml(files) {
  const events = files.map((f) => {
    const [type, num] = f.slice(0, -4).split('_');
    return `    <event eventtype="${type}" enumb="${num}">
      <action>
        <libid>1</libid>
        <id>603</id>
        <kind>7</kind>
        <userelative>0</userelative>
        <isquestion>0</isquestion>
        <useapplyto>-1</useapplyto>
        <exetype>2</exetype>
        <functionname></functionname>
        <codestring></codestring>
        <whoName>self</whoName>
        <relative>0</relative>
        <isnot>0</isnot>
        <arguments>
          <argument>
            <kind>1</kind>
            <string></string>
          </argument>
        </arguments>
      </action>
    </event>`;
  });
  return toCRLF(`<!--This Document is generated by GameMaker, if you edit it by hand then you do so at your own risk!-->
<object>
  <spriteName>&lt;undefined&gt;</spriteName>
  <solid>0</solid>
  <visible>-1</visible>
  <depth>0</depth>
  <persistent>0</persistent>
  <parentName>&lt;undefined&gt;</parentName>
  <maskName>&lt;undefined&gt;</maskName>
  <events>
${events.join('\n')}
  </events>
  <PhysicsObject>0</PhysicsObject>
  <PhysicsObjectSensor>0</PhysicsObjectSensor>
  <PhysicsObjectShape>0</PhysicsObjectShape>
  <PhysicsObjectDensity>0.5</PhysicsObjectDensity>
  <PhysicsObjectRestitution>0.1</PhysicsObjectRestitution>
  <PhysicsObjectGroup>0</PhysicsObjectGroup>
  <PhysicsObjectLinearDamping>0.1</PhysicsObjectLinearDamping>
  <PhysicsObjectAngularDamping>0.1</PhysicsObjectAngularDamping>
  <PhysicsObjectFriction>0.2</PhysicsObjectFriction>
  <PhysicsObjectAwake>-1</PhysicsObjectAwake>
  <PhysicsObjectKinematic>0</PhysicsObjectKinematic>
  <PhysicsShapePoints/>
</object>
`);
}
