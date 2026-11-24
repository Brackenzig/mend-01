// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves recorded by successful move edits, as [old, new] pairs. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- section 3: a file's lines, its break, and its final break ---------- */
interface FileText { br: string; lines: string[]; final: boolean }
function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ---------- section 5: three-tier line matching ---------- */
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
function matchAt(file: string[], i: number, O: string[], tier: number): boolean {
  for (let k = 0; k < O.length; k++) if (!lineEq(file[i + k]!, O[k]!, tier)) return false;
  return true;
}
/** All occurrence positions (occurrences may overlap). */
function occurrences(file: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= file.length; i++) if (matchAt(file, i, O, tier)) out.push(i);
  return out;
}
/** The first tier at which O occurs at least once (strict: tier 0 only). */
function findTier(file: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
type BodyItem = { k: ' ' | '-' | '+' | '\\'; text: string };
function splitItems(items: BodyItem[]): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const it of items) {
    if (it.k === ' ') { O.push(it.text); N.push(it.text); }
    else if (it.k === '-') O.push(it.text);
    else if (it.k === '+') N.push(it.text);
  }
  return { O, N };
}
/**
 * Build the lines that replace the k matched lines at `pos`. Context lines are written as the
 * file's own matched lines; at tier 2 every other (new) line is re-indented: a line that is not
 * empty and not only whitespace, and starts with P (the leading whitespace of O's first line),
 * has that P replaced by F (the leading whitespace of the file's first matched line). When P is
 * empty every non-whitespace line starts with it, so F is prepended.
 */
function renderReplace(file: string[], pos: number, O: string[], items: BodyItem[], tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const F = tier === 2 ? leadWS(file[pos]!) : '';
  const P = tier === 2 ? leadWS(O[0]!) : '';
  for (const it of items) {
    if (it.k === ' ') { out.push(file[pos + oIdx]!); oIdx += 1; }
    else if (it.k === '-') { oIdx += 1; }
    else if (it.k === '+') {
      let l = it.text;
      if (tier === 2 && l.startsWith(P)) l = F + l.slice(P.length);
      out.push(l);
    }
  }
  return out;
}
/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(items: BodyItem[]): boolean {
  let last = -1;
  for (let j = 0; j < items.length; j++) if (items[j]!.k === ' ' || items[j]!.k === '+') last = j;
  if (last < 0) return false;
  return items[last + 1]?.k === '\\';
}

/* ---------- section 6: unified diffs ---------- */
interface Hunk { A: number; items: BodyItem[] }
interface UniSection {
  hdrOld: string | null; hdrNew: string | null;
  renameFrom: string | null; renameTo: string | null;
  diffOld: string | null; diffNew: string | null;
  newFile: boolean; delFile: boolean;
  hasHdrPaths: boolean;
  hunks: Hunk[];
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitItems(h.items);
    if (O.length > 0) {
      const found = findTier(f.lines, O, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) { best = pos; bestDist = dist; }
      }
      const pos = best;
      const repl = renderReplace(f.lines, pos, O, h.items, found.tier);
      if (pos + O.length === f.lines.length) f.final = !hunkNoEol(h.items);
      f.lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + O.length)];
      d += N.length - O.length;
    } else {
      const insertPos = Math.min(h.A + d, f.lines.length);
      const repl = h.items.filter((it) => it.k === '+').map((it) => it.text);
      if (h.items.length > 0 && insertPos === f.lines.length) f.final = !hunkNoEol(h.items);
      f.lines = [...f.lines.slice(0, insertPos), ...repl, ...f.lines.slice(insertPos)];
      d += N.length;
    }
  }
  return joinFile(f);
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.hdrOld ?? sec.renameFrom ?? sec.diffOld;
  const newP = sec.hdrNew ?? sec.renameTo ?? sec.diffNew;
  const oldFile = oldP === '/dev/null' ? null : oldP;
  const newFile = newP === '/dev/null' ? null : newP;
  if (sec.newFile || oldFile === null) {
    const p = newFile;
    if (p === null) return () => {};
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.items.length; j++) {
          if (h.items[j]!.k === '+') content.push(h.items[j]!.text);
        }
      }
      // the last + line of the section, and whether a \ line follows it
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const items = sec.hunks[hi]!.items;
        for (let j = items.length - 1; j >= 0; j--) {
          if (items[j]!.k === '+') { noEol = items[j + 1]?.k === '\\'; break outer; }
        }
      }
      tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (sec.delFile || newFile === null) {
    const p = oldFile;
    if (p === null) return () => {};
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldFile !== newFile) {
    const old = oldFile!;
    const nw = newFile!;
    return (tree) => {
      if (!safe(old)) throw new Fail('unsafe', old);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const before = tree.get(old);
      if (before === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const result = applyHunks(before, sec.hunks, strict, old);
      tree.now.set(old, null);
      tree.now.set(nw, result);
      tree.moves.push([old, nw]);
    };
  }
  const p = oldFile!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const dashPath = (line: string): string => stripPrefix(line.slice(4).split('\t')[0]!.trim());
  const newSection = (): UniSection => {
    const s: UniSection = {
      hdrOld: null, hdrNew: null, renameFrom: null, renameTo: null,
      diffOld: null, diffNew: null, newFile: false, delFile: false, hasHdrPaths: false, hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!.trim();
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = dashPath(line);
        const newP = dashPath(next);
        if (cur === null || !inHeader || cur.hasHdrPaths) {
          cur = newSection();
          inHeader = true;
        }
        cur.hdrOld = oldP;
        cur.hdrNew = newP;
        cur.hasHdrPaths = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.hdrNew = dashPath(line);
        cur.hasHdrPaths = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      inHeader = false;
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          bodyLines.push(bl);
          j++;
        } else break;
      }
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      const items: BodyItem[] = bodyLines.map((bl) => {
        if (bl === '') return { k: ' ', text: '' };
        const c = bl[0]!;
        if (c === ' ') return { k: ' ', text: bl.slice(1) };
        if (c === '-') return { k: '-', text: bl.slice(1) };
        if (c === '+') return { k: '+', text: bl.slice(1) };
        return { k: '\\', text: bl.slice(1) };
      });
      cur.hunks.push({ A, items });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections.map((sec) => uniSectionEdit(sec, strict));
}

/* ---------- section 7: SEARCH/REPLACE blocks ---------- */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ k: '-', text: t })),
      ...newLines.map((t): BodyItem => ({ k: '+', text: t })),
    ];
    const repl = renderReplace(f.lines, pos, oldLines, items, found.tier);
    f.lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { sIdx = j; break; }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= i; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let sepIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { sepIdx = j; break; }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let endIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { endIdx = j; break; }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    i = endIdx + 1;
  }
  return edits;
}

/* ---------- section 8: V4A patches ---------- */
interface V4aChunk { anchor: string | null; items: BodyItem[]; eof: boolean }
type RawLine = { text: string; line: number };

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) if (lineEq(lines[i]!, anchor, t)) return i;
  }
  return -1;
}

function v4aUpdateEdit(path: string, raw: RawLine[], moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const aIdx = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (aIdx < 0) throw new Fail('no-match', path);
        cursor = aIdx + 1;
      }
      const { O, N } = splitItems(ch.items);
      if (O.length > 0) {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let pos = cursor; pos + O.length <= f.lines.length; pos++) {
            if (!matchAt(f.lines, pos, O, t)) continue;
            if (ch.eof && pos + O.length !== f.lines.length) continue;
            found = { tier: t, pos };
            break;
          }
          if (found) break;
        }
        if (!found) throw new Fail('no-match', path);
        const repl = renderReplace(f.lines, found.pos, O, ch.items, found.tier);
        f.lines = [...f.lines.slice(0, found.pos), ...repl, ...f.lines.slice(found.pos + O.length)];
        cursor = found.pos + repl.length;
      } else {
        const insertPos = ch.eof ? f.lines.length : cursor;
        const repl = ch.items.filter((it) => it.k === '+').map((it) => it.text);
        f.lines = [...f.lines.slice(0, insertPos), ...repl, ...f.lines.slice(insertPos)];
        cursor = insertPos + repl.length;
      }
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) if (!blank(lines[j]!)) { last = j; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = l.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i;
    i++;
    const raw: RawLine[] = [];
    while (i < last) {
      const m = lines[i]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      raw.push({ text: m, line: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (let j = idx; j < raw.length; j++) {
        const { text, line } = raw[j]!;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
        } else if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${line}`);
          cur.eof = true;
          cur = null;
        } else if (text.startsWith('*** Move to:')) {
          throw new Exit2(`error: parse ${line}`);
        } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${line}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          if (text === '') cur.items.push({ k: ' ', text: '' });
          else if (text.startsWith(' ')) cur.items.push({ k: ' ', text: text.slice(1) });
          else if (text.startsWith('-')) cur.items.push({ k: '-', text: text.slice(1) });
          else cur.items.push({ k: '+', text: text.slice(1) });
        } else {
          throw new Exit2(`error: parse ${line}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      edits.push(v4aUpdateEdit(path, raw, moveTo, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows: A/D/M per changed path, plus R rows for moves whose final state still looks like a
  // move (old existed before and is gone after; new did not exist before and exists after).
  // An R row replaces that pair's D and A lines and sorts by <new> among the other rows.
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
