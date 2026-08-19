import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The release archives are not source checkouts: `app/*.js` inlines every runtime
 * dependency and the full archive ships `runtime/bun.exe`. By project decision this
 * links to upstream license texts rather than reproducing them, and every entry is
 * derived from installed packages so a new dependency cannot be forgotten.
 */

export interface AttributedComponent {
  name: string;
  version: string;
  licenseId: string;
  url: string;
}

interface ThirdPartyNoticeInput {
  components: readonly AttributedComponent[];
  runtime?: AttributedComponent | undefined;
}

export const THIRD_PARTY_NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.md';

/** Driven by `dependencies` in `package.json`, so a new one cannot be omitted. */
export function collectBundledComponents(
  repositoryRoot: string,
  dependencyNames: readonly string[],
): AttributedComponent[] {
  return [...dependencyNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => readBundledComponent(repositoryRoot, name));
}

export function describeRuntimeComponent(version: string): AttributedComponent {
  return {
    name: 'Bun',
    version,
    licenseId: 'MIT, with bundled components under their own licenses',
    url: `https://github.com/oven-sh/bun/blob/bun-v${version}/LICENSE.md`,
  };
}

export function renderThirdPartyNotices(input: ThirdPartyNoticeInput): string {
  const rows = [...input.components, ...(input.runtime ? [input.runtime] : [])];

  return `${[
    '# Third-Party Notices',
    '',
    'YMB itself is covered by `LICENSE`. This release also contains third-party software',
    'that Yokaiste does not own. Each component below remains licensed under its own terms,',
    'linked beside it.',
    '',
    "Nothing in YMB's own license limits or alters the rights those licenses grant you in",
    'those components.',
    '',
    '| Component | Version | License | Terms |',
    '| --------- | ------- | ------- | ----- |',
    ...rows.map((row) => `| ${row.name} | ${row.version} | ${row.licenseId} | <${row.url}> |`),
    '',
    '## What is where',
    '',
    'The libraries above are compiled into `app/*.js`.',
    '',
    input.runtime
      ? `Bun ${input.runtime.version} ships verbatim as \`runtime/bun.exe\`. It statically links further components under their own licenses, including copyleft ones; its notice at the link above covers them and includes relinking instructions.`
      : 'This archive redistributes no runtime. It runs on a Bun installation you provide.',
    '',
  ]
    .join('\n')
    .trimEnd()}\n`;
}

function readBundledComponent(repositoryRoot: string, name: string): AttributedComponent {
  const packageRoot = path.join(repositoryRoot, 'node_modules', ...name.split('/'));

  let manifest: { version?: unknown; license?: unknown; repository?: unknown; homepage?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw new Error(
      `Cannot read the installed manifest for "${name}". Run "bun install" before building a release.`,
    );
  }

  const version = typeof manifest.version === 'string' ? manifest.version : undefined;
  const licenseId = typeof manifest.license === 'string' ? manifest.license : undefined;
  if (!version || !licenseId) {
    throw new Error(
      `"${name}" does not declare both a version and a license, so it cannot be attributed in ${THIRD_PARTY_NOTICES_FILE_NAME}.`,
    );
  }

  return { name, version, licenseId, url: resolveProjectUrl(name, manifest) };
}

/**
 * `repository` appears as a `github:owner/repo` shorthand, a `git+https://...git` URL,
 * or not at all, so every form is normalized to a plain browsable https address.
 */
function resolveProjectUrl(
  name: string,
  manifest: { repository?: unknown; homepage?: unknown },
): string {
  const repository = manifest.repository;
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' &&
          repository !== null &&
          'url' in repository &&
          typeof repository.url === 'string'
        ? repository.url
        : undefined;

  if (raw) {
    const shorthand = /^github:(.+)$/.exec(raw);
    const normalized = shorthand
      ? `https://github.com/${shorthand[1]}`
      : raw
          .replace(/^git\+/, '')
          .replace(/^(git|ssh):\/\/(git@)?/, 'https://')
          .replace(/\.git$/, '');
    if (normalized.startsWith('https://')) {
      return normalized;
    }
  }

  return typeof manifest.homepage === 'string' && manifest.homepage.startsWith('https://')
    ? manifest.homepage
    : `https://www.npmjs.com/package/${name}`;
}
