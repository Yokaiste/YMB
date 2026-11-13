import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIpcWorker } from '../src/scripts/runtime-shared.ts';

const roots: string[] = [];
const descendantPids: number[] = [];
afterEach(async () => {
  for (const pid of descendantPids.splice(0)) {
    try {
      process.kill(pid);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const length of [32, 2_000_000]) {
  test(`worker stderr is drained with bounded retention (${length} bytes)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ymb-stderr-'));
    roots.push(root);
    const childPath = path.join(root, 'worker.ts');
    await Bun.write(
      childPath,
      `process.once('message', () => {
      process.stderr.write('x'.repeat(${length}), () => process.send({ok: false}, () => process.disconnect()));
    });`,
    );
    const result = await runIpcWorker({
      childPath,
      cwd: root,
      request: {},
      isResponse: (message): message is { ok: boolean } =>
        typeof message === 'object' && message !== null && 'ok' in message,
      errorContext: {
        absolutePath: childPath,
        modId: 'fixture',
        modName: 'Fixture',
        subjectLabel: 'Fixture worker',
      },
      timeoutSeconds: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.response).toEqual({ ok: false });
    expect(result.stderrText).toBe(
      length <= 65536
        ? 'x'.repeat(length)
        : `${'x'.repeat(65536)}\n[stderr truncated after 65536 bytes]`,
    );
  });
}

test('a descendant holding stderr open does not hang a finished worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ymb-stderr-'));
  roots.push(root);
  const childPath = path.join(root, 'worker.ts');
  await Bun.write(
    childPath,
    `process.once('message', () => {
    const descendant = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], {stdin: 'ignore', stdout: 'ignore', stderr: 'inherit'});
    descendant.unref();
    process.send({ok: true, pid: descendant.pid}, () => process.disconnect());
  });`,
  );
  const started = performance.now();
  const result = await runIpcWorker({
    childPath,
    cwd: root,
    request: {},
    isResponse: (message): message is { ok: boolean; pid: number } =>
      typeof message === 'object' && message !== null && 'pid' in message,
    errorContext: {
      absolutePath: childPath,
      modId: 'fixture',
      modName: 'Fixture',
      subjectLabel: 'Fixture worker',
    },
    timeoutSeconds: 5,
  });
  if (result.response?.pid) descendantPids.push(result.response.pid);
  expect(result.exitCode).toBe(0);
  expect(performance.now() - started).toBeLessThan(4_000);
});
