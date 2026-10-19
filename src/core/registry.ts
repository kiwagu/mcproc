import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './manifest.js';
import { registryKey } from './slots.js';
import { stateDir } from './state.js';

/** A checkout this host has seen through its manifest: where the overview of every stack on the host starts from. */
export interface ProjectEntry {
  project: string;
  root: string;
  manifest: string;
}

const projectsDir = (dir: string) => path.join(dir, 'projects');

/** `<state>/projects/<project>-<8 hex of the real root>.json`: the key of the slot registry, so two checkouts named alike never share one. */
export function projectFile(
  dir: string,
  project: string,
  root: string
): string {
  return path.join(projectsDir(dir), `${registryKey(project, root)}.json`);
}

/** Records the checkout when its file is missing or says something else. Best effort: a read-only home never fails a command. */
export function recordProject(
  m: Pick<Manifest, 'project' | 'root' | 'path'>,
  dir = stateDir()
): void {
  try {
    const file = projectFile(dir, m.project, m.root);
    const text = JSON.stringify(
      {
        project: m.project,
        root: m.root,
        manifest: m.path,
      } satisfies ProjectEntry,
      null,
      2
    );
    try {
      if (fs.readFileSync(file, 'utf8') === text) return;
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    // recording is best effort
  }
}

export function forgetProject(
  project: string,
  root: string,
  dir = stateDir()
): void {
  try {
    fs.rmSync(projectFile(dir, project, root), { force: true });
  } catch {}
}

/** Every recorded checkout whose manifest is still in place; the others are dropped. `error` when the directory exists but cannot be read. */
export function listProjects(dir = stateDir()): {
  entries: ProjectEntry[];
  error: string | null;
} {
  let names: string[];
  try {
    names = fs.readdirSync(projectsDir(dir)).filter((n) => n.endsWith('.json'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { entries: [], error: code === 'ENOENT' ? null : String(code ?? e) };
  }
  const entries: ProjectEntry[] = [];
  for (const n of names.sort()) {
    const file = path.join(projectsDir(dir), n);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectEntry;
      if (fs.existsSync(e.manifest)) entries.push(e);
      else fs.rmSync(file, { force: true });
    } catch {
      // a half-written or foreign file: not an entry
    }
  }
  return { entries, error: null };
}
