import fs from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { McprocError } from './errors.js';
import { type Fleet, type HostError, listFleet } from './fleet.js';
import type { LsRow } from './list.js';
import { type Manifest, parseManifest } from './manifest.js';
import { pickHost } from './resolve.js';

/** Linux hands out ports from here for outgoing connections: a listener there is almost always transient. */
export const EPHEMERAL_FROM = 32768;
export interface Adopted {
  app: string;
  host: string;
  ports: number[];
}
export interface Skipped {
  app: string;
  host: string;
  ports: number[];
  reason: string;
}

/**
 * Which undeclared ports each running app may take: not ephemeral, not declared by another app. A port taken earlier in
 * the same run counts as declared by the app that took it, so two apps never adopt one port; a port `m` declares for
 * the app itself is left out.
 */
export function planAdoption(
  rows: LsRow[],
  m: Manifest
): { adopted: Adopted[]; skipped: Skipped[] } {
  const declaredBy = new Map<number, string>();
  for (const [n, a] of Object.entries(m.apps))
    for (const p of a.ports) declaredBy.set(p, n);
  const adopted: Adopted[] = [];
  const skipped: Skipped[] = [];
  for (const r of rows) {
    const take: number[] = [];
    const eph: number[] = [];
    for (const p of r.ports.undeclared) {
      const by = declaredBy.get(p);
      // the plan's manifest may be newer than the one the row was read against: what the app declares there is not undeclared
      if (by === r.app) continue;
      if (p >= EPHEMERAL_FROM) eph.push(p);
      else if (by)
        skipped.push({
          app: r.app,
          host: r.host,
          ports: [p],
          reason: `declared by ${by}`,
        });
      else take.push(p);
    }
    for (const p of take) declaredBy.set(p, r.app);
    if (take.length) adopted.push({ app: r.app, host: r.host, ports: take });
    if (eph.length)
      skipped.push({
        app: r.app,
        host: r.host,
        ports: eph,
        reason: 'ephemeral',
      });
  }
  return { adopted, skipped };
}

/** [start, end of the node's own text, end including what trails it] as the yaml library records it */
type Range = [number, number, number];
const rangeOf = (n: unknown): Range | undefined =>
  (n as { range?: Range } | null)?.range;
const lineStart = (t: string, at: number) => t.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (t: string, at: number) => {
  const i = t.indexOf('\n', at);
  return i < 0 ? t.length : i;
};
/** Step back to the last non-blank character: a block node's range runs past its closing newline. */
const contentEnd = (t: string, at: number) => {
  let e = at;
  while (e > 0 && /\s/.test(t[e - 1])) e--;
  return e;
};
/**
 * The end of the line holding `at`, carried over the comment lines right below it indented at least `min` columns: a
 * block's commented-out tail (`      # - db`). A blank line, or any line left of `min` (the next key, the next app's
 * header comment, a top-level section comment), ends it. The yaml library's range[2] does not stop there: it runs
 * through every blank line and comment up to the next key.
 */
const tailEnd = (t: string, at: number, min: number) => {
  let end = lineEnd(t, at);
  while (end < t.length) {
    const next = lineEnd(t, end + 1);
    const line = t.slice(end + 1, next);
    const body = line.trimStart();
    if (!body.startsWith('#') || line.length - body.length < min) break;
    end = next;
  }
  return end;
};

const NOT_EDITABLE = 'not editable in place (alias or unusual key)';
const ALREADY_DECLARED = 'already declared in the file';

export interface Splice {
  text: string;
  /** the apps whose ports were written in */
  edited: string[];
  /** the apps left as they were, and why */
  unedited: { app: string; reason: string }[];
}

/**
 * The manifest text with the adopted ports written in. Edits are spliced at the YAML nodes' own byte offsets, from the
 * end of the text backwards, so every other byte (comments, spacing, key order) stays as it was; re-serialising the
 * document instead would move comments.
 * - `port: N` becomes `ports: [N, …]` in place; a one-line flow `ports` list is rewritten, sorted, between its brackets;
 *   a flow list over several lines (which may hold comments) gets `, N` after its last item.
 * - A block `ports` list gets a `- N` line in front of the first larger item, or after the list and the commented-out
 *   items that trail it.
 * - An app with no port yet gets `port: N` (one port) or `ports: […]` as a new field after its last one: a line of its
 *   own in a block map, after any commented-out entries that close the last field's block; `, field` before the
 *   closing brace of a flow map.
 * An app that is an alias, or whose ports are all in the text already, is left alone and listed in `unedited`.
 */
export function spliceManifest(text: string, adopted: Adopted[]): Splice {
  const doc = parseDocument(text);
  // declared ports as the loader reads them, aliases resolved
  const js = doc.toJS() as {
    apps?: Record<string, { port?: number; ports?: number[] }>;
  };
  const appsNode = doc.get('apps', true);
  const byApp = new Map<string, number[]>();
  for (const a of adopted)
    byApp.set(a.app, [...(byApp.get(a.app) ?? []), ...a.ports]);
  const edits: { start: number; end: number; insert: string }[] = [];
  const insertAt = (at: number, insert: string) =>
    edits.push({ start: at, end: at, insert });
  const edited: string[] = [];
  const unedited: Splice['unedited'] = [];
  for (const [name, ports] of byApp) {
    // the loader names an app by its key read as a string, so `1:` is app "1" here too
    const app = isMap(appsNode)
      ? appsNode.items.find(
          (p) => isScalar(p.key) && String(p.key.value) === name
        )?.value
      : undefined;
    if (!isMap(app) || app.items.length === 0) {
      unedited.push({ app: name, reason: NOT_EDITABLE });
      continue;
    }
    const own = js.apps?.[name] ?? {};
    const declared = own.ports ?? (own.port === undefined ? [] : [own.port]);
    const added = [...new Set(ports)]
      .filter((p) => !declared.includes(p))
      .sort((x, y) => x - y);
    if (added.length === 0) {
      unedited.push({ app: name, reason: ALREADY_DECLARED });
      continue;
    }
    edited.push(name);
    const all = [...declared, ...added].sort((x, y) => x - y);
    const list = `[${all.join(', ')}]`;
    const pairOf = (k: string) =>
      app.items.find((p) => isScalar(p.key) && p.key.value === k);
    const target = pairOf('ports') ?? pairOf('port');
    if (target) {
      const kr = rangeOf(target.key)!;
      const v = target.value;
      const vr = rangeOf(v)!; // every value node has one, `ports: []` and a value on the next line included
      if (isSeq(v) && v.items.length > 0 && !v.flow) {
        const items = v.items.map((i) => ({
          r: rangeOf(i)!,
          n: isScalar(i) ? Number(i.value) : Number.NaN,
        }));
        const prefix = (r: Range) => text.slice(lineStart(text, r[0]), r[0]); // "      - "
        const before = new Map<number, number[]>();
        const after: number[] = [];
        for (const p of added) {
          const k = items.findIndex((i) => i.n > p);
          if (k < 0) after.push(p);
          else before.set(k, [...(before.get(k) ?? []), p]);
        }
        for (const [k, ps] of before) {
          const r = items[k].r;
          insertAt(
            lineStart(text, r[0]),
            ps.map((p) => `${prefix(r)}${p}\n`).join('')
          );
        }
        if (after.length) {
          const pre = prefix(items[items.length - 1].r);
          const dash = pre.length - pre.trimStart().length; // commented-out items sit at the items' own indent
          insertAt(
            tailEnd(text, contentEnd(text, vr[1]), dash),
            after.map((p) => `\n${pre}${p}`).join('')
          );
        }
      } else if (
        isSeq(v) &&
        v.items.length > 0 &&
        text.slice(vr[0], vr[1]).includes('\n')
      ) {
        const last = rangeOf(v.items[v.items.length - 1])!;
        insertAt(last[1], added.map((p) => `, ${p}`).join(''));
      } else {
        edits.push({ start: vr[0], end: vr[1], insert: list });
        if (isScalar(target.key) && target.key.value === 'port')
          edits.push({ start: kr[0], end: kr[1], insert: 'ports' });
      }
      continue;
    }
    const field =
      declared.length === 0 && all.length === 1
        ? `port: ${all[0]}`
        : `ports: ${list}`;
    const last = app.items[app.items.length - 1];
    const lr = rangeOf(last.value) ?? rangeOf(last.key)!;
    if (app.flow) {
      // the value's own end: with what trails it, a flow map over several lines would put the field in a comment
      insertAt(contentEnd(text, lr[1]), `, ${field}`);
      continue;
    }
    const kr = rangeOf(app.items[0].key)!;
    const indent = text.slice(lineStart(text, kr[0]), kr[0]);
    // under the last value's line and the commented-out entries that close its block, which sit deeper than the keys
    insertAt(
      tailEnd(text, contentEnd(text, lr[1]), indent.length + 1),
      `\n${indent}${field}`
    );
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.start - x.start))
    out = `${out.slice(0, e.start)}${e.insert}${out.slice(e.end)}`;
  return { text: out, edited, unedited };
}

/**
 * A line diff with one line of context on each side of a change and a `…` line between hunks that are not next to each
 * other; [] when the texts are equal.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(` ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1]))
      ops.push(`-${a[i++]}`); // on a tie the old line goes first, as diff prints a replaced line
    else ops.push(`+${b[j++]}`);
  }
  const changed = (k: number) => k >= 0 && k < ops.length && ops[k][0] !== ' ';
  const out: string[] = [];
  let prev = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!changed(k) && !changed(k - 1) && !changed(k + 1)) continue;
    if (out.length > 0 && k !== prev + 1) out.push('…');
    out.push(ops[k]);
    prev = k;
  }
  return out;
}

export interface AdoptResult {
  path: string;
  written: boolean;
  adopted: Adopted[];
  skipped: Skipped[];
  errors: HostError[];
  diff: string[];
}

/**
 * Write the ports `ls` reports as undeclared into the manifest: the hosts are probed like `ls` (an unreachable host is
 * an error entry; its apps are left alone), the plan is made against the text read before probing and spliced into
 * it, and nothing is written when the file changed meanwhile, when there is nothing to adopt, or when no app could be
 * edited in place.
 */
export async function adoptPorts(fleet: Fleet): Promise<AdoptResult> {
  const m = fleet.manifest;
  if (pickHost(m, 'local').readonly)
    throw new McprocError(
      'READONLY_HOST',
      `${m.path} declares the local host readonly; its ports are not adopted`,
      {
        hint: 'Edit the manifest by hand, or remove hosts.local.readonly first.',
      }
    );
  const before = fs.readFileSync(m.path, 'utf8');
  // the text that will be edited, not the copy the fleet loaded earlier: a port declared in between is seen
  const current = parseManifest(before, m.root, m.path);
  // ports come from the listener sections, which the light probe keeps: no CPU sample, tree metrics or URL checks
  const { rows, errors } = await listFleet(fleet, fleet.select(['all']), {
    cpu: 'none',
    metrics: 'none',
    urls: 'none',
  });
  const plan = planAdoption(rows, current);
  const splice = spliceManifest(before, plan.adopted);
  const why = new Map(splice.unedited.map((u) => [u.app, u.reason]));
  const adopted = plan.adopted.filter((a) => !why.has(a.app));
  const skipped = [
    ...plan.skipped,
    ...plan.adopted
      .filter((a) => why.has(a.app))
      .map((a) => ({ ...a, reason: why.get(a.app)! })),
  ];
  if (splice.text === before)
    return { path: m.path, written: false, adopted, skipped, errors, diff: [] };
  try {
    parseManifest(splice.text, m.root, m.path); // never write a manifest the loader would refuse
  } catch (e) {
    const issues = (e as McprocError).details;
    const reason = Array.isArray(issues)
      ? issues.join('; ')
      : (e as Error).message;
    throw new McprocError(
      'MANIFEST_INVALID',
      `adopting the ports would make ${m.path} invalid, so nothing was written: ${reason}`,
      {
        hint: 'Add the ports by hand; ls lists them under ports.undeclared.',
      }
    );
  }
  if (fs.readFileSync(m.path, 'utf8') !== before)
    throw new McprocError(
      'ALREADY_EXISTS',
      `${m.path} changed while the ports were being probed; nothing written`,
      { hint: 'Run init --adopt-ports again.' }
    );
  fs.writeFileSync(m.path, splice.text);
  return {
    path: m.path,
    written: true,
    adopted,
    skipped,
    errors,
    diff: lineDiff(before, splice.text),
  };
}
