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

/** Which undeclared ports each running app may take: not ephemeral, not declared by another app. */
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
      if (p >= EPHEMERAL_FROM) eph.push(p);
      else if (by && by !== r.app)
        skipped.push({
          app: r.app,
          host: r.host,
          ports: [p],
          reason: `declared by ${by}`,
        });
      else take.push(p);
    }
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
/** A block collection's range runs past its closing newline, a scalar's or a flow collection's stops at its last character: step back to that character. */
const contentEnd = (t: string, at: number) => {
  let e = at;
  while (e > 0 && /\s/.test(t[e - 1])) e--;
  return e;
};

/**
 * The manifest text with the adopted ports written in. Edits are spliced at the YAML nodes' own byte offsets, from the
 * end of the text backwards, so every other byte (comments, spacing, key order) stays as it was; re-serialising the
 * document instead would move comments. A `port: N` becomes `ports: [N, …]` in place, a flow `ports` list is rewritten
 * between its brackets, a block `ports` list gets one `- N` line per new port under its last item. An app with no port
 * yet gets `port: N` (one port) or `ports: […]` as a new field after its last one: a line of its own in a block map,
 * `, field` before the closing brace of a flow map.
 */
export function spliceManifest(text: string, adopted: Adopted[]): string {
  const doc = parseDocument(text);
  // declared ports as the loader reads them, aliases resolved
  const js = doc.toJS() as {
    apps?: Record<string, { port?: number; ports?: number[] }>;
  };
  const byApp = new Map<string, number[]>();
  for (const a of adopted)
    byApp.set(a.app, [...(byApp.get(a.app) ?? []), ...a.ports]);
  const edits: { start: number; end: number; insert: string }[] = [];
  for (const [name, ports] of byApp) {
    const app = doc.getIn(['apps', name], true);
    if (!isMap(app) || app.items.length === 0) continue;
    const own = js.apps?.[name] ?? {};
    const declared = own.ports ?? (own.port === undefined ? [] : [own.port]);
    const added = [...new Set(ports)]
      .filter((p) => !declared.includes(p))
      .sort((x, y) => x - y);
    if (added.length === 0) continue;
    const all = [...declared, ...added].sort((x, y) => x - y);
    const list = `[${all.join(', ')}]`;
    const pairOf = (k: string) =>
      app.items.find((p) => isScalar(p.key) && p.key.value === k);
    const target = pairOf('ports') ?? pairOf('port');
    if (target) {
      const kr = rangeOf(target.key)!;
      const v = target.value;
      if (isSeq(v) && !v.flow && v.items.length > 0) {
        const ir = rangeOf(v.items[v.items.length - 1])!;
        const prefix = text.slice(lineStart(text, ir[0]), ir[0]); // "      - "
        const at = lineEnd(text, contentEnd(text, ir[1]));
        const lines = added.map((p) => `\n${prefix}${p}`).join('');
        edits.push({ start: at, end: at, insert: lines });
      } else {
        const vr = rangeOf(v)!; // every value node has one, `ports: []` and a value on the next line included
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
    const end = contentEnd(
      text,
      (rangeOf(last.value) ?? rangeOf(last.key)!)[1]
    );
    if (app.flow) {
      edits.push({ start: end, end, insert: `, ${field}` });
      continue;
    }
    const kr = rangeOf(app.items[0].key)!;
    const indent = text.slice(lineStart(text, kr[0]), kr[0]);
    // the end of the last field's line, past its trailing comment: the new line goes right under it
    const at = lineEnd(text, end);
    edits.push({ start: at, end: at, insert: `\n${indent}${field}` });
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.start - x.start))
    out = `${out.slice(0, e.start)}${e.insert}${out.slice(e.end)}`;
  return out;
}

/** A line diff with one line of context on each side of a change, no hunk headers; [] when the texts are equal. */
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
  return ops.filter((_, k) => changed(k) || changed(k - 1) || changed(k + 1));
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
 * an error entry; its apps are left alone), the plan is spliced into the text read before probing, and nothing is
 * written when the file changed meanwhile or when there is nothing to adopt.
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
  // ports come from the listener sections, which the light probe keeps: no CPU sample, tree metrics or URL checks
  const { rows, errors } = await listFleet(fleet, fleet.select(['all']), {
    cpu: 'none',
    metrics: 'none',
    urls: 'none',
  });
  const plan = planAdoption(rows, m);
  if (plan.adopted.length === 0)
    return { path: m.path, written: false, ...plan, errors, diff: [] };
  const after = spliceManifest(before, plan.adopted);
  parseManifest(after, m.root, m.path); // never write a manifest the loader would refuse
  if (fs.readFileSync(m.path, 'utf8') !== before)
    throw new McprocError(
      'ALREADY_EXISTS',
      `${m.path} changed while the ports were being probed; nothing written`,
      { hint: 'Run init --adopt-ports again.' }
    );
  fs.writeFileSync(m.path, after);
  return {
    path: m.path,
    written: true,
    ...plan,
    errors,
    diff: lineDiff(before, after),
  };
}
