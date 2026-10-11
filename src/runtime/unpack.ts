import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McprocError } from '../core/errors.js';
import type { Host, Manifest } from '../core/manifest.js';
import { runtimeDir } from '../core/pm2.js';
import { clearResolutionCache } from '../core/resolve.js';
import { ensureOk } from '../transport/index.js';
import { shq } from '../transport/quote.js';
import type { ExecOptions, Transport } from '../transport/types.js';
import { VERSION } from '../version.js';
import { ensurePm2Bundle, type Pm2Bundle } from './bundle.js';
import { needsNode, plannedWrites, type UnpackOptions } from './decide.js';
import { manifestCopy, renderLock, renderWrapper, verifyScript, type RuntimeLock } from './files.js';
import { fetchNodeTarball, resolveNodeVersion } from './node-dist.js';
import type { NodePlatform } from './platform.js';
import { UNPACK_MARK, parseUnpackProbe, unpackProbeScript } from './probe.js';

export interface UnpackDeps {
  pm2Bundle(): Promise<Pm2Bundle>;
  nodeVersion(requested: string | undefined, platform: NodePlatform): Promise<string>;
  nodeTarball(version: string, platform: NodePlatform): Promise<{ data: Buffer; sha256: string }>;
  hostname(): string;
  now(): Date;
}

export function defaultUnpackDeps(): UnpackDeps {
  return {
    pm2Bundle: () => ensurePm2Bundle(),
    nodeVersion: (requested, platform) => resolveNodeVersion(requested, platform),
    nodeTarball: async (version, platform) => {
      const t = await fetchNodeTarball(version, platform);
      return { data: fs.readFileSync(t.path), sha256: t.sha256 };
    },
    hostname: () => os.hostname(),
    now: () => new Date(),
  };
}

export interface UnpackTarget { manifest: Manifest; host: Host; transport: Transport }
export interface UnpackResult {
  host: string; runtime_dir: string; noop: boolean;
  pm2: { version: string; written: boolean };
  node: { version: string; platform: NodePlatform; written: boolean } | null;
  manifest_copy: 'written' | 'kept-hand-written' | 'not-needed-local';
  runtime_line: string | null; monit: string; update_hint: string | null;
}

export async function unpack(target: UnpackTarget, opts: UnpackOptions, deps: UnpackDeps): Promise<UnpackResult> {
  const { manifest, host, transport } = target;
  const rt = opts.dir ?? runtimeDir(host);
  if (!rt.startsWith('/')) {
    throw new McprocError('BAD_ARGUMENT', `dir must be an absolute path on host "${host.name}", got "${rt}"`, { hint: '"~" and relative paths are not expanded.' });
  }
  const env = host.pm2_home ? { PM2_HOME: host.pm2_home } : undefined;
  const run = async (what: string, cmd: string, o: ExecOptions = {}) => {
    const res = ensureOk(await transport.exec(cmd, { env, ...o }), host, what);
    if (res.code !== 0) {
      throw new McprocError('TRANSPORT_FAILED', `${what} failed on ${transport.describe()} (exit ${res.code}): ${(res.stderr || res.stdout).trim().split('\n').slice(-5).join('\n')}`);
    }
    return res;
  };
  const dotDir = path.posix.join(host.cwd, '.mcproc');
  const remoteManifest = path.posix.join(dotDir, 'mcproc.yaml');

  // 1. one probe round trip
  const pr = ensureOk(await transport.exec(unpackProbeScript(rt, remoteManifest), { env }), host, 'unpack probe');
  if (!pr.stdout.includes(UNPACK_MARK)) {
    throw new McprocError('TRANSPORT_FAILED', `the shell on ${transport.describe()} did not run the unpack probe (exit ${pr.code}): ${(pr.stderr || pr.stdout).trim()}`, { hint: `Check hosts.${host.name}.shell; hosts without bash need shell: /bin/sh -c` });
  }
  const facts = parseUnpackProbe(pr.stdout);
  if (!facts.tar) throw new McprocError('TAR_NOT_FOUND', `${transport.describe()} has no tar; unpack streams its archives into tar -xzf -`, { hint: 'Install tar on that host (busybox tar is enough).' });
  if (facts.foreignBin && !opts.force) {
    throw new McprocError('BAD_ARGUMENT', `${rt}/bin already holds a pm2 or node that mcproc did not write (no ${rt}/lock.json); refusing to overwrite it`, { hint: 'Point dir at a directory of its own (the default is <cwd>/.mcproc/runtime), or pass force: true to replace those files.' });
  }

  // 2. everything that can fail without touching the host happens first
  const node = needsNode(facts, opts);
  const bundle = await deps.pm2Bundle();
  // an unpacked Node stays at its locked version: upgrades happen only on an explicit node_version or force, never because a newer LTS appeared
  const wanted = opts.nodeVersion ?? (opts.force ? undefined : facts.lock?.node ?? undefined);
  const nodeVersion = node.need ? await deps.nodeVersion(wanted, node.platform!) : null;
  const writes = plannedWrites(facts, opts, bundle.version, nodeVersion);
  const nodeTar = writes.writeNode ? await deps.nodeTarball(nodeVersion!, node.platform!) : null;

  // 3. writes on the host
  const pm2Dir = `${rt}/pm2/${bundle.version}`;
  const nodeDir = nodeVersion ? `${rt}/node/${nodeVersion}` : '';
  if (writes.writePm2) await run('pm2 extraction', `mkdir -p ${shq(pm2Dir)} && tar -xzf - -C ${shq(pm2Dir)}`, { stdin: bundle.data, timeoutMs: 300_000 });
  if (writes.writeNode) await run('node extraction', `mkdir -p ${shq(nodeDir)} && tar -xzf - -C ${shq(nodeDir)} --strip-components=1`, { stdin: nodeTar!.data, timeoutMs: 600_000 });
  if (writes.writePm2 || writes.writeNode) {
    const link = writes.writeNode ? ` && ln -sfn ${shq(`${nodeDir}/bin/node`)} ${shq(`${rt}/bin/node`)}` : '';
    await run('wrapper', `mkdir -p ${shq(`${rt}/bin`)} && cat > ${shq(`${rt}/bin/pm2`)} && chmod 755 ${shq(`${rt}/bin/pm2`)}${link}`, { stdin: renderWrapper(rt, bundle.version) });
    const lock: RuntimeLock = {
      mcproc: VERSION, pm2: bundle.version, pm2_sha256: bundle.sha256,
      node: writes.writeNode ? nodeVersion : facts.lock?.node ?? null,
      node_sha256: writes.writeNode ? nodeTar!.sha256 : facts.lock?.node_sha256 ?? null,
      platform: writes.writeNode ? node.platform : facts.lock?.platform ?? null,
      written_at: deps.now().toISOString(), by: deps.hostname(),
    };
    await run('lock', `cat > ${shq(`${rt}/lock.json`)}`, { stdin: renderLock(lock) });
  }

  // 4. manifest copy on remote hosts; a hand-written manifest there is never overwritten without force
  let manifestState: UnpackResult['manifest_copy'] = 'not-needed-local';
  if (!host.local) {
    if (facts.manifest === 'hand-written' && !opts.force) {
      manifestState = 'kept-hand-written';
    } else {
      const gi = `${dotDir}/.gitignore`;
      await run('manifest copy', `mkdir -p ${shq(`${dotDir}/.generated`)} && { [ -e ${shq(gi)} ] || printf '*\\n' > ${shq(gi)}; } && cat > ${shq(remoteManifest)}`, { stdin: manifestCopy(fs.readFileSync(manifest.path, 'utf8'), deps.hostname(), deps.now()) });
      const readme = path.join(manifest.root, '.mcproc', 'README.md');
      if (fs.existsSync(readme)) await run('readme copy', `[ -e ${shq(`${dotDir}/README.md`)} ] || cat > ${shq(`${dotDir}/README.md`)}`, { stdin: fs.readFileSync(readme, 'utf8') });
      manifestState = 'written';
    }
  }

  // 5. verify without starting a daemon (pm2 -v would spawn one)
  const v = await run('runtime check', verifyScript(rt, bundle.version));
  const got = v.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (got !== bundle.version) {
    throw new McprocError('PM2_FAILED', `the runtime at ${rt} reports pm2 "${got}", expected ${bundle.version}`, { hint: 'Run unpack again with force: true.' });
  }

  clearResolutionCache(); // the next connect re-probes and finds <rt>/bin/pm2
  const pm2Home = host.pm2_home ? `PM2_HOME=${shq(host.pm2_home)} ` : '';
  const pm2Cmd = `${pm2Home}${shq(`${rt}/bin/pm2`)}`;
  return {
    host: host.name, runtime_dir: rt, noop: !writes.writePm2 && !writes.writeNode,
    pm2: { version: bundle.version, written: writes.writePm2 },
    node: nodeVersion ? { version: nodeVersion, platform: node.platform!, written: writes.writeNode } : null,
    manifest_copy: manifestState,
    runtime_line: opts.dir && opts.dir !== runtimeDir(host) ? `hosts.${host.name}.runtime: ${opts.dir}` : null,
    monit: `${pm2Cmd} monit`,
    // any runtime change under a live daemon: it keeps running the old pm2 and/or node until `update` restarts it
    update_hint: facts.daemonUp && ((writes.writePm2 && facts.lock?.pm2 !== bundle.version) || (writes.writeNode && facts.lock?.node !== nodeVersion))
      ? `a pm2 daemon is already running there${facts.lock ? ` (started from pm2 ${facts.lock.pm2}${facts.lock.node ? `, node ${facts.lock.node}` : ''})` : ''}; to move it to the new runtime run: ${pm2Cmd} update`
      : null,
  };
}
