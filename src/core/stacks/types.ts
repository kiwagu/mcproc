import type { Manifest } from '../manifest.js';
import type { LsRow, HostProbe } from '../list.js';

export interface StackError {
  code: string;
  message: string;
  hint?: string;
}
export interface StackHost {
  name: string;
  endpoint: string;
  reachable: boolean;
  error: string | null;
  age_s: number;
}
export interface StackApps {
  total: number;
  online: number;
  errored: number;
  stopped: number;
  queued: number;
}
export interface Stack {
  project: string;
  root: string;
  base_project: string;
  slot: number | null;
  branch: string | null;
  source: 'registry' | 'daemon';
  hosts: StackHost[];
  apps: StackApps;
  /** the lowest queue position among its queued apps; null when none waits */
  queue_position: number | null;
  memory: number;
  cpu: number | null;
  ports: { app: string; port: number }[];
  manifest_error: StackError | null;
  notes: string[];
  /** some of its processes exist in pm2 (any status) or wait in the queue */
  present: boolean;
}
export interface OrphanProcess {
  name: string;
  status: string;
  memory: number;
}
export interface Orphan {
  namespace: string;
  endpoint: string;
  processes: OrphanProcess[];
  note: string | null;
}
export interface StacksHost {
  name: string;
  memory: { available_mib: number; total_mib: number } | null;
  watcher: { online: boolean; pid: number | null } | null;
  queue: number;
  notes: string[];
}
export interface StacksAnswer {
  host: StacksHost;
  stacks: Stack[];
  orphans: Orphan[];
}
/** A stack with the app rows the overview's lower pane shows (not part of the JSON answer). */
export interface StackView extends Stack {
  rows: LsRow[];
}

/** A checkout as discovery sees it, before any probe. */
export interface ProjectInput {
  project: string;
  root: string;
  source: 'registry' | 'daemon';
  manifest: Manifest | null;
  error: StackError | null;
  /** the hosts its apps run on: host name → endpoint key */
  endpoints: Record<string, string>;
  slot: number | null;
  branch: string | null;
}
/** What one endpoint answered this refresh (or last, when it is not due or failed). */
export interface EndpointRead {
  key: string;
  label: string;
  probe: HostProbe | null;
  error: string | null;
  age_s: number;
}
