// Parser for GameMaker 6 / Studio 1.4 GML. The grammar is gml.peggy; gml.parser.mjs is generated from it with
//   npx -y peggy@5.1.0 --format es --allowed-start-rules Program,Tokens -o migrate/lib/gml.parser.mjs migrate/lib/gml.peggy
import * as generated from './gml.parser.mjs';

function run(src, startRule) {
  try {
    return generated.parse(src, { startRule });
  } catch (e) {
    if (!e.location) throw e;
    const line = e.location.start.line;
    throw new SyntaxError(`${e.message} at line ${line}: ${src.split('\n')[line - 1]?.trim()}`);
  }
}

// The AST: a Block of statements, every node {type, start, end, ...} with source offsets.
export const parse = (src) => run(src, 'Program');

// Flat {type: 'str'|'num'|'id'|'op'|'eof', value, start, end} tokens.
export const tokenize = (src) => run(src, 'Tokens');

// Calls fn(node, parent) for every node, depth first.
export function walk(n, fn, parent = null) {
  fn(n, parent);
  for (const v of Object.values(n)) {
    if (Array.isArray(v))
      for (const c of v) {
        if (c?.type) walk(c, fn, n);
      }
    else if (v?.type) walk(v, fn, n);
  }
}

// Applies non-overlapping {start, end, text} edits to src.
export function applyEdits(src, edits) {
  edits = [...edits].sort((a, b) => b.start - a.start);
  let last = Infinity;
  for (const e of edits) {
    if (e.end > last) throw new Error(`overlapping edits at ${e.start}`);
    src = src.slice(0, e.start) + e.text + src.slice(e.end);
    last = e.start;
  }
  return src;
}

export const isCall = (n, name) =>
  n.type === 'Call' && n.callee.type === 'Identifier' && (!name || n.callee.name === name);
