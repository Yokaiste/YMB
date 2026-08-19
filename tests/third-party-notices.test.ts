import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { RELEASE_REQUIRED_FILES } from '../scripts/release-metadata.ts';
import {
  type AttributedComponent,
  collectBundledComponents,
  describeRuntimeComponent,
  renderThirdPartyNotices,
  THIRD_PARTY_NOTICES_FILE_NAME,
} from '../scripts/third-party-notices.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const dependencyNames = Object.keys(packageDefinition.dependencies);

function fakeComponent(overrides: Partial<AttributedComponent> = {}): AttributedComponent {
  return {
    name: 'example',
    version: '1.0.0',
    licenseId: 'MIT',
    url: 'https://github.com/example/example',
    ...overrides,
  };
}

describe('third-party notices', () => {
  test('every runtime dependency is attributed from its installed manifest', () => {
    const components = collectBundledComponents(repositoryRoot, dependencyNames);
    expect(components.map((component) => component.name)).toEqual(
      [...dependencyNames].sort((left, right) => left.localeCompare(right)),
    );

    for (const component of components) {
      expect(component.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(component.licenseId).not.toBe('');
      // A link that does not resolve to a real project is worse than no link.
      expect(component.url).toStartWith('https://');
      expect(component.url).not.toContain('git+');
      expect(component.url).not.toEndWith('.git');
    }
  });

  test('repository shorthand and git URLs both normalize to a browsable address', () => {
    const byName = new Map(
      collectBundledComponents(repositoryRoot, dependencyNames).map((component) => [
        component.name,
        component.url,
      ]),
    );
    // `commander` declares `git+https://...git`, `yaml` declares `github:owner/repo`.
    expect(byName.get('commander')).toBe('https://github.com/tj/commander.js');
    expect(byName.get('yaml')).toBe('https://github.com/eemeli/yaml');
    expect(byName.get('zod')).toBe('https://github.com/colinhacks/zod');
  });

  test('an uninstalled dependency fails the build instead of being dropped silently', () => {
    expect(() => collectBundledComponents(repositoryRoot, ['not-installed-anywhere'])).toThrow(
      /bun install/,
    );
  });

  test('the rendered notice lists every component with its terms link', () => {
    const components = [
      fakeComponent({ name: 'alpha', version: '2.3.4', url: 'https://example.com/alpha' }),
      fakeComponent({
        name: 'beta',
        version: '0.1.0',
        licenseId: 'ISC',
        url: 'https://example.com/beta',
      }),
    ];
    const notices = renderThirdPartyNotices({ components });

    expect(notices).toContain('| alpha | 2.3.4 | MIT | <https://example.com/alpha> |');
    expect(notices).toContain('| beta | 0.1.0 | ISC | <https://example.com/beta> |');
    // The notice must not imply it supersedes the licenses it points at.
    expect(notices).toContain('remains licensed under its own terms');
  });

  test('the runtime row tracks whether Bun is actually shipped', () => {
    const components = [fakeComponent()];
    const runtime = describeRuntimeComponent('1.2.3');

    const withRuntime = renderThirdPartyNotices({ components, runtime });
    expect(withRuntime).toContain('| Bun | 1.2.3 |');
    expect(withRuntime).toContain('<https://github.com/oven-sh/bun/blob/bun-v1.2.3/LICENSE.md>');
    // Bun statically links LGPL components, so the notice has to say the link
    // covers more than Bun's own MIT terms.
    expect(withRuntime).toContain('copyleft');
    expect(withRuntime).toContain('relinking');

    const withoutRuntime = renderThirdPartyNotices({ components });
    expect(withoutRuntime).not.toContain('| Bun |');
    expect(withoutRuntime).toContain('redistributes no runtime');
  });

  test('the runtime link always points at the pinned Bun version', () => {
    const requiredBunVersion = packageDefinition.packageManager.replace(/^bun@/, '');
    const runtime = describeRuntimeComponent(requiredBunVersion);
    expect(runtime.version).toBe(requiredBunVersion);
    expect(runtime.url).toContain(`bun-v${requiredBunVersion}`);
  });

  test('the notice is a required release file, so no archive can ship without it', () => {
    expect(RELEASE_REQUIRED_FILES).toContain(THIRD_PARTY_NOTICES_FILE_NAME);
  });

  test('the build resolves notices before it writes anything', async () => {
    const build = await readFile(path.join(repositoryRoot, 'scripts', 'build-release.ts'), 'utf8');
    const noticeIndex = build.indexOf('collectBundledComponents(');
    const wipeIndex = build.indexOf('await rm(metadata.distRoot');
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(wipeIndex).toBeGreaterThan(noticeIndex);
  });
});
