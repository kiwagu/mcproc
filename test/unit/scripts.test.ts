import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARK,
  dockerMemSnippet,
  dockerScript,
  listenScript,
  probeScript,
} from '../../src/shell/snippets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  fs.readFileSync(
    path.join(here, '..', 'fixtures', 'probe', 'scripts.json'),
    'utf8'
  )
) as {
  probe: { ask: Parameters<typeof probeScript>[1]; script: string }[];
  listen: { jlist: boolean; script: string }[];
};

describe('the scripts other hosts run', () => {
  it.each(recorded.probe)(
    'probeScript $ask is unchanged, byte for byte',
    ({ ask, script }) => {
      expect(probeScript('pm2', ask)).toBe(script);
    }
  );
  it.each(recorded.listen)(
    'listenScript jlist=$jlist is unchanged, byte for byte',
    ({ jlist, script }) => {
      expect(listenScript('pm2', jlist)).toBe(script);
    }
  );
});

describe('dockerScript', () => {
  it('the published ports alone; with names, the memory of those containers too', () => {
    expect(dockerScript([])).toContain(MARK.DOCKER);
    expect(dockerScript([])).not.toContain(MARK.DOCKERMEM);
    expect(dockerScript(['db'])).toContain(dockerMemSnippet(['db']));
  });
  it("the probe's own docker ports lines", () => {
    expect(probeScript('pm2').split('\n')).toEqual(
      expect.arrayContaining(dockerScript([]).split('\n'))
    );
  });
});
