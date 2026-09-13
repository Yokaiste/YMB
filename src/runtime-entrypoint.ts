import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveRuntimeEntrypoint(moduleUrl: string, baseName: string): string {
  const bundledPath = fileURLToPath(new URL(`./${baseName}.js`, moduleUrl));
  if (existsSync(bundledPath)) {
    return bundledPath;
  }
  return fileURLToPath(new URL(`./${baseName}.ts`, moduleUrl));
}
