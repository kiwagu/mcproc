import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { McprocError } from './errors.js';
import { NAME_RE } from './names.js';
import type { VarValue } from './template.js';

export const OVERRIDE_REL = path.join('.mcproc', 'mcproc.local.yaml');

/** The per-checkout override: a project slug and var values; nothing else may differ between checkouts of one manifest. */
export interface Override {
  path: string;
  project?: string;
  /** the main checkout of the repository, recorded by worktree add so the slot registry can be found from a worktree */
  repo?: string;
  vars: Record<string, VarValue>;
}

const overrideSchema = z
  .object({
    project: z
      .string()
      .regex(NAME_RE, 'must match ^[a-z0-9][a-z0-9._-]*$')
      .optional(),
    repo: z.string().min(1).optional(),
    // a key left empty in YAML parses as null: treat it as no vars
    vars: z.preprocess(
      (v) => (v === null || v === undefined ? {} : v),
      z.record(z.union([z.string(), z.number(), z.boolean()]))
    ),
  })
  .strict();

/** Parses the text of an override file; refuses unknown keys and a project slug that is not a valid name. */
export function parseOverride(text: string, overridePath: string): Override {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new McprocError(
      'MANIFEST_INVALID',
      `YAML parse error in ${overridePath}: ${(e as Error).message}`
    );
  }
  const res = overrideSchema.safeParse(raw);
  if (!res.success)
    throw new McprocError(
      'MANIFEST_INVALID',
      `Invalid override ${overridePath}:\n  ${res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ')}`,
      { hint: 'The override may set only project, repo and vars.' }
    );
  return {
    path: overridePath,
    project: res.data.project,
    ...(res.data.repo !== undefined ? { repo: res.data.repo } : {}),
    vars: res.data.vars,
  };
}

/** The override next to the manifest of `root`, or null when the checkout has none. */
export function loadOverride(root: string): Override | null {
  const p = path.join(root, OVERRIDE_REL);
  if (!fs.existsSync(p)) return null;
  return parseOverride(fs.readFileSync(p, 'utf8'), p);
}

/** Writes the override of a checkout (worktree add), replacing any earlier one; returns its path. */
export function writeOverride(
  root: string,
  o: { project: string; repo?: string; vars?: Record<string, VarValue> }
): string {
  const p = path.join(root, OVERRIDE_REL);
  const body: Record<string, unknown> = { project: o.project };
  if (o.repo) body.repo = o.repo;
  if (o.vars && Object.keys(o.vars).length) body.vars = o.vars;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `# Written by mcproc worktree add: this checkout's project slug and vars.\n${toYaml(body)}`
  );
  return p;
}
