// Imports the assets the original game loaded from its install folder at runtime
// (Music, Voice, BG) as ordinary project resources, plus the fonts' original glyph bitmaps from the exe.
// Requires ffmpeg on PATH for GIF -> PNG, and ffprobe for sound channel counts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isCall, parse, walk } from './lib/gml.mjs';

const read = (f) => fs.readFileSync(f, 'utf8');
const pngSize = (f) => {
  const b = fs.readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};
const toPng = (gif, png) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', gif, '-frames:v', '1', png]);
const setTags = (xml, tags) =>
  Object.entries(tags).reduce((x, [t, v]) => x.replace(new RegExp(`<${t}>[^<]*</${t}>`), `<${t}>${v}</${t}>`), xml);

// sound_replace(mSound,'Music\_file.mp3',...) calls in the original code say which file each placeholder sound is.
export function soundReplacements(codeFiles) {
  const found = new Map();
  for (const src of codeFiles) {
    walk(parse(src), (n) => {
      if (isCall(n, 'sound_replace') && n.args[0].type === 'Identifier' && n.args[1].type === 'String')
        found.set(n.args[0].name, n.args[1].value.replace(/\\/g, '/'));
    });
  }
  return found;
}

export function importSounds(projectDir, gameDir, replacements, log) {
  for (const [sound, file] of replacements) {
    const src = path.join(gameDir, file),
      ext = path.extname(file).toLowerCase();
    if (!fs.existsSync(src)) {
      log(`missing ${file} for ${sound}`);
      continue;
    }
    const gmx = path.join(projectDir, 'sound', `${sound}.sound.gmx`);
    let xml = read(gmx);
    fs.rmSync(path.join(projectDir, 'sound', 'audio', /<data>([^<]*)<\/data>/.exec(xml)[1]));
    fs.copyFileSync(src, path.join(projectDir, 'sound', 'audio', sound + ext));
    xml = setTags(xml, { extension: ext, origname: `sound\\audio\\${sound}${ext}`, data: sound + ext });
    // MP3 music: background-music kind, compressed and streamed.
    if (ext === '.mp3') xml = setTags(xml, { kind: 1, compressed: 1, streamed: 1 });
    fs.writeFileSync(gmx, xml);
  }
}

// The importer makes every sound mono unless its GMX type is stereo (1), which would lose the stereo music and effects.
export function markStereoSounds(projectDir) {
  const dir = path.join(projectDir, 'sound');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sound.gmx'))) {
    const xml = read(path.join(dir, f));
    const data = path.join(dir, 'audio', /<data>([^<]*)<\/data>/.exec(xml)[1]);
    const channels = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=channels',
      '-of',
      'csv=p=0',
      data,
    ]);
    if (channels.toString().trim() === '2') fs.writeFileSync(path.join(dir, f), setTags(xml, { type: 1 }));
  }
}

// Backgrounds were shipped as 1x1 placeholders; the real images are BG/<name>.gif.
export function importBackgrounds(projectDir, gameDir, log) {
  const dir = path.join(projectDir, 'background');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.background.gmx'))) {
    const name = f.slice(0, -'.background.gmx'.length),
      gif = path.join(gameDir, 'BG', `${name}.gif`);
    const xml = read(path.join(dir, f)),
      png = path.join(dir, /<data>([^<]*)<\/data>/.exec(xml)[1].replace(/\\/g, '/'));
    if (pngSize(png).join() !== '1,1') continue;
    if (!fs.existsSync(gif)) {
      log(`no image for placeholder background ${name}`);
      continue;
    }
    toPng(gif, png);
    const [width, height] = pngSize(png);
    fs.writeFileSync(path.join(dir, f), setTags(xml, { width, height }));
  }
}

// Battle backdrops BG/BG0.gif..BGn.gif become the frames of sBBattle (drawn with image_index=global.b_back).
export function importBattleBackdrops(projectDir, gameDir) {
  const gifs = fs
    .readdirSync(path.join(gameDir, 'BG'))
    .map((f) => /^BG(\d+)\.gif$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const frames = gifs.map((i) => {
    toPng(path.join(gameDir, 'BG', `BG${i}.gif`), path.join(projectDir, 'sprites', 'images', `sBBattle_${i}.png`));
    return `\r\n    <frame index="${i}">images\\sBBattle_${i}.png</frame>`;
  });
  const [w, h] = pngSize(path.join(projectDir, 'sprites', 'images', 'sBBattle_0.png'));
  const gmx = path.join(projectDir, 'sprites', 'sBBattle.sprite.gmx');
  const xml = setTags(read(gmx), { width: w, height: h, bbox_right: w - 1, bbox_bottom: h - 1 });
  fs.writeFileSync(
    gmx,
    xml.replace(/<frames\/>|<frames>[\s\S]*<\/frames>/, `<frames>${frames.join('')}\r\n  </frames>`),
  );
}

// The GMX export re-rendered every font from system TTFs with anti-aliasing (and GZFruit, which isn't
// installed, as an Arial-like fallback). The GM6 exe holds the original glyph bitmaps: decrypt its game
// data the way GMDecompiler does and copy each font's glyph table and bitmap into the project.
export function importFonts(projectDir, gameDir, log) {
  const exe = fs.readFileSync(path.join(gameDir, 'BarkleyV120.exe'));
  let p = exe.indexOf(Buffer.from([0x91, 0xd5, 0x12, 0, 0x58, 0x02, 0, 0])) + 8; // 1234321, 600
  const int = (b = exe) => {
    p += 4;
    return b.readInt32LE(p - 4);
  };
  const str = (b = exe) => {
    const n = b.readInt32LE(p);
    p += 4 + n;
    return b.toString('latin1', p - n, p);
  };
  p += 12; // include count, remove at end, don't overwrite
  for (let name = str(); name !== 'READY'; name = str()) p += 4 + int();
  const data = zlib.inflateSync(exe.subarray(p + 4, p + 4 + exe.readInt32LE(p)));
  // Byte substitution keyed after two index tables; the first byte after the key is not encrypted.
  p = 4;
  const [c1, c2] = [int(data), int(data)];
  p += 4 * c1;
  const key = int(data);
  p += 4 * c2 + 1;
  const [a, b] = [6 + (key % 250), Math.trunc(key / 250)],
    t = [...Array(256).keys()],
    inv = new Uint8Array(256);
  for (let i = 1; i <= 10000; i++) {
    const j = 1 + ((i * a + b) % 254);
    [t[j], t[j + 1]] = [t[j + 1], t[j]];
  }
  for (let i = 1; i < 256; i++) inv[t[i]] = i;
  for (let i = p; i < data.length; i++) data[i] = inv[data[i]];

  const dir = path.join(projectDir, 'fonts');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.font.gmx'))) {
    const name = f.slice(0, -'.font.gmx'.length);
    let xml = read(path.join(dir, f));
    const face = /<name>([^<]*)<\/name>/.exec(xml)[1];
    // Resource entry: name, version, face name, size, bold, italic, first char, last char.
    const sig = (s) => Buffer.concat([Buffer.from(Int32Array.of(s.length).buffer), Buffer.from(s, 'latin1')]);
    const sites = [];
    for (let i = data.indexOf(sig(name)); i >= 0; i = data.indexOf(sig(name), i + 1)) {
      p = i + 4 + name.length + 4;
      if (str(data) !== face) continue;
      p += 12;
      if (int(data) === 32 && int(data) === 127) sites.push(p);
    }
    if (sites.length !== 1) {
      log(`font ${name}: found ${sites.length} entries in the exe`);
      continue;
    }
    p = sites[0];
    const glyphs = [];
    for (let c = 0; c < 256; c++) {
      const [x, y, w, h, shift, offset] = [0, 0, 0, 0, 0, 0].map(() => int(data));
      if (c >= 32 && c <= 127)
        glyphs.push(
          `\r\n    <glyph character="${c}" x="${x}" y="${y}" w="${w}" h="${h}" shift="${shift}" offset="${offset}"/>`,
        );
    }
    const [w, h] = [int(data), int(data)];
    const alpha = zlib.inflateSync(data.subarray(p + 4, p + 4 + data.readInt32LE(p)));
    const rgba = Buffer.alloc((w * 4 + 1) * h, 0xff); // white; each row starts with filter byte 0
    for (let y = 0; y < h; y++) {
      rgba[y * (w * 4 + 1)] = 0;
      for (let x = 0; x < w; x++) rgba[y * (w * 4 + 1) + 4 + x * 4] = alpha[y * w + x];
    }
    fs.writeFileSync(path.join(dir, /<image>([^<]*)<\/image>/.exec(xml)[1]), png(w, h, rgba));
    // <glyphs/> when there are none, which is how an XML writer other than GameMaker's spells it.
    xml = setTags(xml, { aa: 0 }).replace(
      /<glyphs\/>|<glyphs>[\s\S]*<\/glyphs>/,
      `<glyphs>${glyphs.join('')}\r\n  </glyphs>`,
    );
    fs.writeFileSync(path.join(dir, f), xml);
  }
}

// 8-bit RGBA PNG from filtered scanlines.
function png(w, h, scanlines) {
  const chunk = (type, body) => {
    const b = Buffer.alloc(body.length + 12);
    b.writeUInt32BE(body.length);
    b.write(type, 4, 'latin1');
    body.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + body.length)), 8 + body.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
