#!/usr/bin/env node

// Imports a migrated GMX into a GameMaker LTS project without the IDE, using the IDE's ProjectTool (the installed
// IDE's, or one toolchain.mjs downloads), and fails if the importer reports GML it could not convert (it leaves such
// files as 1.4 code).
//
//   node src/import.mjs <migrated GMX dir> <output .yyp path> [ProjectTool path]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './offline.mjs';
import { projectTool } from './toolchain.mjs';

// The files that ship into the page live in src/web/: index.html (the page template) and pwa/ (the app manifest and
// icon) come in here; the page app itself is built into every HTML5 build instead (src/page.mjs, src/offline.mjs).
const web = (f) => path.join(import.meta.dirname, 'web', f);

const [gmx, yyp, tool = projectTool()] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!yyp) {
  console.error('usage: node import.mjs <migrated GMX dir> <output .yyp path> [ProjectTool path]');
  process.exit(1);
}
if (fs.existsSync(path.dirname(yyp))) {
  console.error(`${path.dirname(yyp)} already exists`);
  process.exit(1);
}

const project = fs.readdirSync(gmx).find((f) => f.endsWith('.project.gmx'));
const script = path.join(os.tmpdir(), `barkley-import-${process.pid}.txt`);
fs.writeFileSync(script, `PROJECT OPEN SOURCE="${path.join(gmx, project)}"\nPROJECT SAVE DESTINATION="${yyp}"\n`);
console.log(`importing ${project} with ${tool}`);
execFileSync(tool, ['SCRIPT', `PATH=${script}`], { cwd: path.dirname(tool), stdio: 'ignore' });
fs.rmSync(script);

// The extensions declare the functions the GML calls; the page (src/web/src/extensions/) defines them, and each
// extension's file only turns its part of the page on as the runtime loads it. The HTML5 runtime's
// window_set_fullscreen does nothing, so Fullscreen provides fullscreen_set and fullscreen_get (called by patch 14 and
// modernized/05). Resume keeps the game state across a reload for patch modernized/06, so only a modernized migration
// gets it.
addExtension('Fullscreen', 'fullscreen.js', [
  ['fullscreen_set', [2], 2],
  ['fullscreen_get', [], 2],
]);
if (fs.existsSync(path.join(gmx, 'scripts', 'resume_save.gml')))
  addExtension('Resume', 'resume.js', [
    ['resume_put', [1], 2],
    ['resume_take', [], 1],
    ['resume_clear', [], 2],
  ]);
// Saves carries the save slots in and out of browser storage as text, for patch modernized/09.
if (fs.existsSync(path.join(gmx, 'scripts', 'sSaveData.gml')))
  addExtension('Saves', 'saves.js', [['saves_open', [1], 2]]);
// Touch draws the mobile control overlay for patch modernized/10.
if (fs.readFileSync(path.join(gmx, 'scripts', 'key_doset.gml'), 'utf8').includes('touch_keys'))
  addExtension('Touch', 'touch.js', [
    ['touch_keys', [2, 2, 2, 2, 2, 2, 2], 2],
    ['touch_context', [2], 2],
    ['touch_active', [], 2],
    ['touch_view_x', [], 2],
    ['touch_view_y', [], 2],
    ['touch_view_w', [], 2],
    ['touch_view_h', [], 2],
    ['touch_dpr', [], 2],
  ]);
// Gamepad sends the bound keys from a game controller, for patch modernized/11.
if (fs.readFileSync(path.join(gmx, 'scripts', 'key_doset.gml'), 'utf8').includes('pad_keys'))
  addExtension('Gamepad', 'gamepad.js', [
    ['pad_keys', [2, 2, 2, 2, 2, 2, 2], 2],
    ['pad_context', [2], 2],
  ]);
// Controls turns on the Controls panel, which the Start screen opens before the game runs. It is a page feature, so
// nothing in the GML calls it; it ships with a modernized migration, beside Gamepad.
if (fs.readFileSync(path.join(gmx, 'scripts', 'key_doset.gml'), 'utf8').includes('pad_keys'))
  addExtension('Controls', 'controls.js', [['controls_show', [], 2]]);
// Crash records what a crash report needs for patch modernized/07.
if (
  fs.existsSync(path.join(gmx, 'scripts', 'resume_tick.gml')) &&
  fs.readFileSync(path.join(gmx, 'scripts', 'resume_tick.gml'), 'utf8').includes('crash_put')
)
  addExtension('Crash', 'crash.js', [
    ['crash_put', [1, 1], 2],
    ['crash_step', [2], 2],
    ['crash_wanted', [], 2],
    ['crash_end', [1], 2],
  ]);

// Adds an extension to the project: a JavaScript file that turns its part of the page on, declaring the functions the
// page defines for it. functions are [name, argument types, return type], where a type is 1 (string) or 2 (real).
function addExtension(name, file, functions) {
  const extension = path.join(path.dirname(yyp), 'extensions', name);
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(
    path.join(extension, file),
    `// Written by src/import.mjs. The page (app/barkley.js, built from src/web) defines the ${name} extension's\n` +
      `// functions: ${functions.map(([fn]) => fn).join(', ')}.\n` +
      `// The runtime loads this file with the game, which turns them on.\n` +
      `barkley.extension(${JSON.stringify(name)});\n`,
  );
  fs.writeFileSync(
    path.join(extension, `${name}.yy`),
    `{
  "$GMExtension":"",
  "%Name":"${name}",
  "androidactivityinject":"",
  "androidclassname":"",
  "androidcodeinjection":"",
  "androidinject":"",
  "androidmanifestinject":"",
  "androidPermissions":[],
  "androidProps":false,
  "androidsourcedir":"",
  "author":"",
  "classname":"",
  "copyToTargets":-1,
  "description":"",
  "exportToGame":true,
  "extensionVersion":"1.0.0",
  "files":[
    {"$GMExtensionFile":"","%Name":"${file}","constants":[],"copyToTargets":-1,"filename":"${file}","final":"","functions":[
${functions.map(([fn, args, type]) => `        {"$GMExtensionFunction":"","%Name":"${fn}","argCount":${args.length},"args":[${args.map((t) => `${t},`).join('')}],"documentation":"","externalName":"${fn}","help":"","hidden":false,"kind":5,"name":"${fn}","resourceType":"GMExtensionFunction","resourceVersion":"2.0","returnType":${type},},\n`).join('')}      ],"init":"","kind":5,"name":"${file}","order":[
${functions.map(([fn]) => `        {"name":"${fn}","path":"extensions/${name}/${name}.yy",},\n`).join('')}      ],"origname":"","ProxyFiles":[],"resourceType":"GMExtensionFile","resourceVersion":"2.0","uncompress":false,"usesRunnerInterface":false,},
  ],
  "gradleinject":"",
  "hasConvertedCodeInjection":true,
  "helpfile":"",
  "HTML5CodeInjection":"",
  "html5Props":false,
  "IncludedResources":[],
  "installdir":"",
  "iosCocoaPodDependencies":"",
  "iosCocoaPods":"",
  "ioscodeinjection":"",
  "iosdelegatename":"",
  "iosplistinject":"",
  "iosProps":false,
  "iosSystemFrameworkEntries":[],
  "iosThirdPartyFrameworkEntries":[],
  "license":"",
  "maccompilerflags":"",
  "maclinkerflags":"",
  "macsourcedir":"",
  "name":"${name}",
  "options":[],
  "optionsFile":"options.json",
  "packageId":"",
  "parent":{
    "name":"Extensions",
    "path":"folders/Extensions.yy",
  },
  "productId":"",
  "resourceType":"GMExtension",
  "resourceVersion":"2.0",
  "sourcedir":"",
  "supportedTargets":-1,
  "tvosclassname":"",
  "tvosCocoaPodDependencies":"",
  "tvosCocoaPods":"",
  "tvoscodeinjection":"",
  "tvosdelegatename":"",
  "tvosmaccompilerflags":"",
  "tvosmaclinkerflags":"",
  "tvosplistinject":"",
  "tvosProps":false,
  "tvosSystemFrameworkEntries":[],
  "tvosThirdPartyFrameworkEntries":[],
}
`,
  );
  fs.writeFileSync(
    yyp,
    fs
      .readFileSync(yyp, 'utf8')
      .replace('"resources":[\n', `$&    {"id":{"name":"${name}","path":"extensions/${name}/${name}.yy",},},\n`),
  );
}

// Files the page uses, as Included Files, which the HTML5 build copies into html5game/ beside the game (index.html
// links them from there): the web manifest and its icons, made from web/pwa/icon.png, which make the page
// installable as an app (PWA).
const datafiles = path.join(path.dirname(yyp), 'datafiles');
fs.mkdirSync(datafiles);
const included = ['manifest.webmanifest'];
for (const f of included) fs.copyFileSync(web(`pwa/${f}`), path.join(datafiles, f));
for (const size of [180, 192, 512]) {
  const icon = `icon-${size}.png`;
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    web('pwa/icon.png'),
    '-vf',
    `scale=${size}:${size}:flags=lanczos`,
    path.join(datafiles, icon),
  ]);
  included.push(icon);
}
const project_yyp = fs.readFileSync(yyp, 'utf8');
if (!project_yyp.includes('"IncludedFiles":[],')) throw new Error('no empty IncludedFiles list in the .yyp');
fs.writeFileSync(
  yyp,
  project_yyp.replace(
    '"IncludedFiles":[],',
    () =>
      `"IncludedFiles":[\n${included.map((f) => `    {"$GMIncludedFile":"","%Name":"${f}","CopyToMask":-1,"filePath":"datafiles","name":"${f}","resourceType":"GMIncludedFile","resourceVersion":"2.0",},\n`).join('')}  ],`,
  ),
);

// The importer skips the HTML5 options, so write them: the game's name as the page title, web/index.html as the page
// (it loads the page app, the Start screen and the rest), and barkley_loading (the page's) as the loading bar. Igor
// finds the index only by absolute path.
const html5 = path.join(path.dirname(yyp), 'options', 'html5');
fs.mkdirSync(html5, { recursive: true });
fs.copyFileSync(web('index.html'), path.join(html5, 'index.html'));
fs.writeFileSync(
  path.join(html5, 'options_html5.yy'),
  `{
  "$GMHtml5Options":"",
  "%Name":"HTML5",
  "name":"HTML5",
  "option_html5_allow_fullscreen":true,
  "option_html5_browser_title":"Barkley, Shut Up and Jam: Gaiden",
  "option_html5_centregame":false,
  "option_html5_display_cursor":true,
  "option_html5_facebook_app_display_name":"",
  "option_html5_facebook_id":"",
  "option_html5_flurry_enable":false,
  "option_html5_flurry_id":"",
  "option_html5_foldername":"html5game",
  "option_html5_google_analytics_enable":false,
  "option_html5_google_tracking_id":"",
  "option_html5_icon":"\${base_options_dir}/html5/fav.ico",
  "option_html5_index":${JSON.stringify(path.join(html5, 'index.html'))},
  "option_html5_interpolate_pixels":false,
  "option_html5_jsprepend":"",
  "option_html5_loadingbar":"barkley_loading",
  "option_html5_localrunalert":true,
  "option_html5_outputdebugtoconsole":true,
  "option_html5_outputname":"index.html",
  "option_html5_scale":0,
  "option_html5_splash_png":"\${base_options_dir}/html5/splash.png",
  "option_html5_texture_page":"2048x2048",
  "option_html5_usebuiltinfont":true,
  "option_html5_usebuiltinparticles":true,
  "option_html5_usesplash":false,
  "option_html5_use_facebook":false,
  "option_html5_version":"${VERSION}.0",
  "option_html5_webgl":2,
  "resourceType":"GMHtml5Options",
  "resourceVersion":"2.0",
}
`,
);

const notes = path.join(path.dirname(yyp), 'notes');
const report = fs
  .readdirSync(notes, { recursive: true })
  .filter((f) => /^compatibility_report.*\.txt$/.test(path.basename(f)))
  .map((f) => fs.readFileSync(path.join(notes, f), 'utf8'))
  .join('\n');
const problems = report.split('\n').filter((l) => /^ERROR|^Too many errors/.test(l));
console.log(problems.length ? `importer could not convert:\n${problems.join('\n')}` : 'importer converted all GML');
console.log(`project: ${yyp}`);
process.exit(problems.length ? 1 : 0);
