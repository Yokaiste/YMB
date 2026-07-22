import path from 'node:path';
import { type BuildScriptCacheTools, ScriptToolError } from '../api.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import {
  CACHE_SALT,
  pruneCacheDirectory,
  readCacheEntry,
  writeCacheEntryAtomic,
} from '../engine/cache-store.ts';
import { hashBytes, hashText } from '../hash.ts';
import type { ScriptApplication, ScriptRuntimePlan } from '../types.ts';
import { collectScriptDependencySources } from './dependency-hash.ts';

const CACHE_COMPONENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function createScriptCacheTools(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
): BuildScriptCacheTools {
  const enabled = plan.selection.useCache !== false;
  const cacheRoot = path.join(
    plan.context.buildRoot,
    BUILDER_CONFIG.cacheDirectoryName,
    'scripts',
    script.mod.config.id,
    script.patch?.config.id ?? 'mod',
  );

  return Object.freeze({
    enabled,
    hash(content: string | Uint8Array): string {
      return typeof content === 'string' ? hashText(content) : hashBytes(content);
    },
    async createKey(input: unknown): Promise<string> {
      const dependencies = await collectScriptDependencySources({
        entryAbsolutePaths: [script.absolutePath],
        rootAbsolutePath: plan.context.ymbRoot,
      });
      try {
        return hashText(
          JSON.stringify({
            salt: CACHE_SALT,
            modId: script.mod.config.id,
            patchId: script.patch?.config.id ?? null,
            scriptPath: script.config.path,
            dependencies: dependencies.map(({ relativePath, sourceHash }) => ({
              relativePath,
              sourceHash,
            })),
            input,
          }),
        );
      } catch (error) {
        throw new ScriptToolError({
          reason: 'Script cache-key input is not JSON-serializable.',
          suggestion: 'Use only JSON-compatible values when creating a script cache key.',
          details: [error instanceof Error ? error.message : String(error)],
        });
      }
    },
    async readJson<T>(
      namespace: string,
      key: string,
      validate: (value: unknown) => value is T,
    ): Promise<T | undefined> {
      const cachePath = resolveCachePath(cacheRoot, namespace, key);
      if (!enabled) {
        return undefined;
      }
      try {
        const entry = await readCacheEntry(cachePath, cacheKind(namespace));
        if (!entry) {
          return undefined;
        }
        const value: unknown = JSON.parse(entry.content);
        return validate(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async writeJson(namespace: string, key: string, value: unknown): Promise<void> {
      const cachePath = resolveCachePath(cacheRoot, namespace, key);
      if (!enabled) {
        return;
      }
      let content: string;
      try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          throw new TypeError('The value has no JSON representation.');
        }
        content = serialized;
      } catch (error) {
        throw new ScriptToolError({
          reason: 'Script cache value is not JSON-serializable.',
          suggestion:
            'Write only JSON-compatible objects, arrays, strings, numbers, booleans, or null.',
          details: [error instanceof Error ? error.message : String(error)],
        });
      }
      try {
        await writeCacheEntryAtomic(cachePath, cacheKind(namespace), content);
        await pruneCacheDirectory(path.dirname(cachePath), {
          maxEntries: BUILDER_CONFIG.scriptCacheMaxEntriesPerNamespace,
          maxBytes: BUILDER_CONFIG.scriptCacheMaxBytesPerNamespace,
        });
      } catch {
        // Script caches are opportunistic and never block generation.
      }
    },
  });
}

function resolveCachePath(cacheRoot: string, namespace: string, key: string): string {
  assertCacheComponent(namespace, 'namespace');
  assertCacheComponent(key, 'key');
  return path.join(cacheRoot, namespace, `${key}.json`);
}

function cacheKind(namespace: string): string {
  return `script-json:${namespace}`;
}

function assertCacheComponent(value: string, label: string): void {
  if (!CACHE_COMPONENT_PATTERN.test(value)) {
    throw new ScriptToolError({
      reason: `Script cache ${label} \`${value}\` is invalid.`,
      suggestion: `Use only letters, numbers, dots, underscores, and hyphens in cache ${label}s.`,
    });
  }
}
