import type {
  ProgressCommandName,
  ProgressDisplayEvent,
  ProgressGroup,
  ProgressModel,
  ProgressSnapshot,
  ProgressStageMapping,
} from './progress-types.ts';

const PROGRESS_GROUPS = {
  planningValidationMaterialization: [
    { id: 'planning', label: 'World Scan' },
    { id: 'validation', label: 'Integrity Sweep' },
    { id: 'materialization', label: 'Output Probe' },
  ],
  planningReportCatalog: [
    { id: 'planning', label: 'World Scan' },
    { id: 'report', label: 'Catalog View' },
  ],
  planningReportSelection: [
    { id: 'planning', label: 'World Scan' },
    { id: 'report', label: 'Selection Trace' },
  ],
  planningReportPaths: [
    { id: 'planning', label: 'World Scan' },
    { id: 'report', label: 'Path Audit' },
  ],
  planningMaterializationWrite: [
    { id: 'planning', label: 'World Scan' },
    { id: 'materialization', label: 'Mod Fabrication' },
    { id: 'write', label: 'Preview Write' },
  ],
  planningMaterializationWriteManifest: [
    { id: 'planning', label: 'World Scan' },
    { id: 'materialization', label: 'Mod Fabrication' },
    { id: 'write', label: 'Live Sync' },
    { id: 'manifest', label: 'Recovery Ledger' },
  ],
  recoveryWriteManifest: [
    { id: 'planning', label: 'Recovery Scan' },
    { id: 'write', label: 'Recovery Write' },
    { id: 'manifest', label: 'Recovery Ledger' },
  ],
  cleanupWrite: [
    { id: 'planning', label: 'Cleanup Scan' },
    { id: 'write', label: 'Temp Cleanup' },
  ],
} satisfies Record<string, ProgressGroup[]>;

export function getProgressModel(commandName: ProgressCommandName): ProgressModel {
  const baseMappings: Record<string, ProgressStageMapping> = {
    'Resolving builder context': {
      groupId: 'planning',
      nowLabel: 'Resolving builder context',
      nextHint: 'Discovering source mods',
    },
    'Discovering source mods': {
      groupId: 'planning',
      nowLabel: 'Discovering source mods',
      nextHint: 'Planning selected patches',
    },
    'Planning selected patches': {
      groupId: 'planning',
      nowLabel: 'Planning selected patches',
    },
    'Preparing validation plan': {
      groupId: 'planning',
      nowLabel: 'Preparing validation plan',
      nextHint: 'Resolving builder context',
    },
    'Preparing source mod list': {
      groupId: 'planning',
      nowLabel: 'Preparing source mod list',
      nextHint: 'Resolving builder context',
    },
    'Explaining selected patches': {
      groupId: 'planning',
      nowLabel: 'Preparing selection explanation',
      nextHint: 'Resolving builder context',
    },
    'Inspecting builder paths': {
      groupId: 'planning',
      nowLabel: 'Inspecting builder paths',
      nextHint: 'Resolving builder context',
    },
    'Preparing build plan': {
      groupId: 'planning',
      nowLabel: 'Preparing build plan',
      nextHint: 'Resolving builder context',
    },
    'Preparing sync plan': {
      groupId: 'planning',
      nowLabel: 'Preparing sync plan',
      nextHint: 'Resolving builder context',
    },
    'Loading recovery manifest': {
      groupId: 'planning',
      nowLabel: 'Loading recovery manifest',
    },
    'Loading sync manifest': {
      groupId: 'write',
      nowLabel: 'Loading sync manifest',
      nextHint: 'Syncing live files',
    },
    'Preparing cleanup plan': {
      groupId: 'planning',
      nowLabel: 'Preparing cleanup plan',
      nextHint: 'Resolving builder context',
    },
    'Validating patch targets': {
      groupId: 'validation',
      nowLabel: 'Validating patch target',
      nextHint: 'Validating replace files',
    },
    'Validating replace files': {
      groupId: 'validation',
      nowLabel: 'Validating replace file',
      nextHint: 'Validating replace templates',
    },
    'Validating replace templates': {
      groupId: 'validation',
      nowLabel: 'Checking generated replace templates',
      nextHint: 'Materializing generated outputs',
    },
    'Materializing generated outputs': {
      groupId: 'materialization',
      nowLabel: 'Preparing generated outputs',
      nextHint: 'Materializing patch outputs',
    },
    'Materializing build outputs': {
      groupId: 'materialization',
      nowLabel: 'Preparing preview outputs',
      nextHint: 'Materializing patch outputs',
    },
    'Materializing sync outputs': {
      groupId: 'materialization',
      nowLabel: 'Preparing live-sync outputs',
      nextHint: 'Materializing patch outputs',
    },
    'Materializing patch outputs': {
      groupId: 'materialization',
      nowLabel: 'Merging patch output',
      nextHint: 'Running generation script tests',
    },
    'Running generation script tests': {
      groupId: 'materialization',
      nowLabel: 'Generation script pipeline',
      activityLabel: 'tests',
      nextHint: 'Materializing replace outputs',
    },
    'Running generation scripts': {
      groupId: 'materialization',
      nowLabel: 'Generation script pipeline',
      activityLabel: 'run',
      nextHint: 'Materializing replace outputs',
    },
    'Materializing replace outputs': {
      groupId: 'materialization',
      nowLabel: 'Materializing replace output',
    },
    'Preparing preview output files': {
      groupId: 'write',
      nowLabel: 'Preparing preview file',
      nextHint: 'Preview review',
    },
    'Writing preview output files': {
      groupId: 'write',
      nowLabel: 'Writing preview file',
      nextHint: 'Preview review',
    },
    'Syncing live files': {
      groupId: 'write',
      nowLabel: 'Syncing live file',
      nextHint: 'Cleaning obsolete live files',
    },
    'Cleaning obsolete live files': {
      groupId: 'write',
      nowLabel: 'Cleaning obsolete live file',
      nextHint: 'Saving sync manifest',
    },
    'Saving sync manifest': {
      groupId: 'manifest',
      nowLabel: 'Saving sync manifest',
      nextHint: 'Live mod verification',
    },
    'Recovering tracked files': {
      groupId: 'write',
      nowLabel: 'Recovering tracked file',
      nextHint: 'Saving recovery manifest',
    },
    'Saving recovery manifest': {
      groupId: 'manifest',
      nowLabel: 'Saving recovery manifest',
      nextHint: 'Recovery review',
    },
    'Collecting YMB temp artifacts': {
      groupId: 'write',
      nowLabel: 'Collecting YMB temp artifacts',
      nextHint: 'Removing YMB temp artifacts',
    },
    'Removing YMB temp artifacts': {
      groupId: 'write',
      nowLabel: 'Removing temp artifact',
      nextHint: 'Cleanup review',
    },
  };
  const reportOverride = (
    message: string,
    nowLabel: string,
    nextHint: string,
  ): Record<string, ProgressStageMapping> => ({
    [message]: {
      groupId: 'report',
      nowLabel,
      nextHint,
    },
  });
  const createProgressModel = (
    groups: ProgressGroup[],
    overrides?: Record<string, ProgressStageMapping>,
  ): ProgressModel => ({
    groups,
    mappings: overrides ? { ...baseMappings, ...overrides } : baseMappings,
  });

  switch (commandName) {
    case 'validate':
      return createProgressModel(PROGRESS_GROUPS.planningValidationMaterialization);
    case 'list':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportCatalog,
        reportOverride(
          'Preparing source mod list',
          'Preparing source mod list',
          'Discovering source mods',
        ),
      );
    case 'explain':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportSelection,
        reportOverride(
          'Explaining selected patches',
          'Preparing selection explanation',
          'Resolving builder context',
        ),
      );
    case 'doctor':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportPaths,
        reportOverride(
          'Inspecting builder paths',
          'Inspecting builder paths',
          'Resolving builder context',
        ),
      );
    case 'build':
      return createProgressModel(PROGRESS_GROUPS.planningMaterializationWrite);
    case 'sync':
      return createProgressModel(PROGRESS_GROUPS.planningMaterializationWriteManifest);
    case 'recover':
      return createProgressModel(PROGRESS_GROUPS.recoveryWriteManifest);
    case 'cleanup':
      return createProgressModel(PROGRESS_GROUPS.cleanupWrite);
  }
}

export function createProgressSnapshot(
  commandName: ProgressCommandName,
  model: ProgressModel,
  event: ProgressDisplayEvent,
): ProgressSnapshot {
  const stage = model.mappings[event.message];
  const fallbackGroup = model.groups[0] ?? { id: 'boot', label: 'Boot Sequence' };
  const currentGroupId = stage?.groupId ?? fallbackGroup.id;
  const groupIndex = Math.max(
    0,
    model.groups.findIndex((group) => group.id === currentGroupId),
  );
  const groupLabel = model.groups[groupIndex]?.label ?? fallbackGroup.label;
  const groupMessages = Object.entries(model.mappings)
    .filter(([, mapping]) => mapping.groupId === currentGroupId)
    .map(([message]) => message);
  const messageIndex = Math.max(0, groupMessages.indexOf(event.message));
  const countFraction =
    event.current !== undefined && event.total !== undefined && event.total > 0
      ? Math.min(1, event.current / event.total)
      : undefined;
  // Counts describe progress inside the current stage, not across the entire
  // group. Folding the stage index into the fraction prevents the bar from
  // jumping backwards when a new counted stage starts at 0/N.
  const groupFraction =
    groupMessages.length > 0
      ? (messageIndex + (countFraction ?? 0.35)) / groupMessages.length
      : (countFraction ?? 0.2);
  const groupCount = Math.max(1, model.groups.length);
  const overallFraction = Math.min(0.99, (groupIndex + groupFraction) / groupCount);
  const nextHint =
    stage?.nextHint ??
    groupMessages[0] ??
    model.groups[groupIndex + 1]?.label ??
    `Completing ${commandName}`;

  return {
    overallFraction,
    groupLabel,
    nowLine: formatCurrentProgressLine(
      stage?.nowLabel ?? event.message,
      stage?.activityLabel,
      event,
    ),
    nextLine: `NEXT ${nextHint}`,
    current: event.current,
    total: event.total,
  };
}

function formatCurrentProgressLine(
  nowLabel: string,
  activityLabel: string | undefined,
  event: ProgressDisplayEvent,
): string {
  const parts = [nowLabel];
  if (activityLabel) {
    parts.push(`[${activityLabel}]`);
  }
  const counts = formatCompactCounts(event.current, event.total);
  if (counts) {
    parts.push(counts);
  }
  if (event.detail) {
    parts.push(event.detail);
  }
  return parts.join(' ');
}

function formatCompactCounts(current?: number, total?: number): string | undefined {
  if (current === undefined || total === undefined || total <= 0) {
    return undefined;
  }

  return `[${current}/${total}]`;
}
