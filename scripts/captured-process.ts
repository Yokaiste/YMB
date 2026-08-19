export interface CapturedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** Run a release helper without losing either output stream on failure. */
export async function runCapturedProcess(
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CapturedProcessResult> {
  const child = Bun.spawn(command, {
    ...options,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
}
