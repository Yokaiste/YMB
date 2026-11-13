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
    { id: 'planning', label: 'Scanning project' },
    { id: 'validation', label: 'Checking files' },
    { id: 'materialization', label: 'Building output' },
  ],
  planningReportCatalog: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'report', label: 'Listing mod projects' },
  ],
  planningReportSelection: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'report', label: 'Checking selection' },
  ],
  planningReportPaths: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'report', label: 'Checking paths' },
  ],
  planningReportMatches: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'report', label: 'Searching files' },
  ],
  planningMaterializationWrite: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'materialization', label: 'Building output' },
    { id: 'write', label: 'Writing preview' },
  ],
  // Sync reads the manifest and checks every tracked file before it builds
  // anything, so that pass gets a step of its own rather than hiding inside
  // planning or reading as an early start on the write phase.
  planningTrackedMaterializationWriteManifest: [
    { id: 'planning', label: 'Scanning project' },
    { id: 'tracked', label: 'Checking game files' },
    { id: 'materialization', label: 'Building output' },
    { id: 'write', label: 'Updating game files' },
    { id: 'manifest', label: 'Saving recovery data' },
  ],
  recoveryWriteManifest: [
    { id: 'planning', label: 'Reading recovery data' },
    { id: 'write', label: 'Restoring files' },
    { id: 'manifest', label: 'Saving recovery data' },
  ],
  cleanupWrite: [
    { id: 'planning', label: 'Finding temp files' },
    { id: 'write', label: 'Removing temp files' },
  ],
} satisfies Record<string, ProgressGroup[]>;

const BASE_STAGE_MAPPINGS: Record<string, ProgressStageMapping> = {
  'Resolving builder context': {
    groupId: 'planning',
    nowLabel: 'Checking folders',
    nextHint: 'Finding mod projects',
  },
  'Discovering mod projects': {
    groupId: 'planning',
    nowLabel: 'Finding mod projects',
    nextHint: 'Choosing patches',
  },
  'Planning selected patches': {
    groupId: 'planning',
    nowLabel: 'Choosing patches',
  },
  'Preparing validation plan': {
    groupId: 'planning',
    nowLabel: 'Preparing checks',
    nextHint: 'Checking folders',
  },
  'Preparing mod project list': {
    groupId: 'planning',
    nowLabel: 'Finding mod projects',
    nextHint: 'Checking folders',
  },
  'Preparing search': {
    groupId: 'planning',
    nowLabel: 'Preparing search',
    nextHint: 'Checking folders',
  },
  'Explaining selected patches': {
    groupId: 'planning',
    nowLabel: 'Checking patch selection',
    nextHint: 'Checking folders',
  },
  'Inspecting builder paths': {
    groupId: 'planning',
    nowLabel: 'Checking folders',
    nextHint: 'Checking folders',
  },
  'Preparing build plan': {
    groupId: 'planning',
    nowLabel: 'Planning preview',
    nextHint: 'Checking folders',
  },
  'Preparing sync plan': {
    groupId: 'planning',
    nowLabel: 'Planning sync',
    nextHint: 'Checking folders',
  },
  'Loading recovery manifest': {
    groupId: 'planning',
    nowLabel: 'Reading saved-file list',
  },
  'Loading sync manifest': {
    groupId: 'tracked',
    nowLabel: 'Reading last sync',
    nextHint: 'Checking previously synced files',
  },
  'Checking tracked live files': {
    groupId: 'tracked',
    nowLabel: 'Checking a synced file',
    nextHint: 'Building files to apply',
  },
  'Resetting changed live files': {
    groupId: 'tracked',
    nowLabel: 'Restoring a saved original',
    nextHint: 'Building files to apply',
  },
  'Preparing cleanup plan': {
    groupId: 'planning',
    nowLabel: 'Finding temporary files',
    nextHint: 'Checking folders',
  },
  'Validating patch targets': {
    groupId: 'validation',
    nowLabel: 'Checking patch target',
    nextHint: 'Checking replacement files',
  },
  'Validating replace files': {
    groupId: 'validation',
    nowLabel: 'Checking replacement file',
    nextHint: 'Checking text templates',
  },
  'Validating replace templates': {
    groupId: 'validation',
    nowLabel: 'Checking text templates',
    nextHint: 'Building generated files',
  },
  'Materializing generated outputs': {
    groupId: 'materialization',
    nowLabel: 'Building generated files',
    nextHint: 'Applying patches in memory',
  },
  'Materializing build outputs': {
    groupId: 'materialization',
    nowLabel: 'Building preview files',
    nextHint: 'Applying patches in memory',
  },
  'Materializing sync outputs': {
    groupId: 'materialization',
    nowLabel: 'Building files to apply',
    nextHint: 'Applying patches in memory',
  },
  'Materializing patch outputs': {
    groupId: 'materialization',
    nowLabel: 'Combining patch results',
    nextHint: 'Running script tests',
  },
  'Running generation script tests': {
    groupId: 'materialization',
    nowLabel: 'Running scripts',
    activityLabel: 'tests',
    nextHint: 'Preparing replacement files',
  },
  'Running generation scripts': {
    groupId: 'materialization',
    nowLabel: 'Running scripts',
    activityLabel: 'run',
    nextHint: 'Preparing replacement files',
  },
  // Tests a script declared `when: after`, so this stage follows the run rather
  // than preceding it. Unmapped, it would send the bar back to the first step.
  'Running generation output checks': {
    groupId: 'materialization',
    nowLabel: 'Running scripts',
    activityLabel: 'output checks',
    nextHint: 'Preparing replacement files',
  },
  'Materializing replace outputs': {
    groupId: 'materialization',
    nowLabel: 'Preparing replacement file',
  },
  'Validating NDF outputs': {
    groupId: 'materialization',
    nowLabel: 'Checking finished NDF files',
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
    nowLabel: 'Applying file to WARNO mod',
    nextHint: 'Removing old build output',
  },
  'Cleaning obsolete live files': {
    groupId: 'write',
    nowLabel: 'Removing old build output',
    nextHint: 'Recording applied changes',
  },
  'Saving sync manifest': {
    groupId: 'manifest',
    nowLabel: 'Recording applied changes',
    nextHint: 'Compile with GenerateMod.bat',
  },
  'Recovering tracked files': {
    groupId: 'write',
    nowLabel: 'Restoring file',
    nextHint: 'Recording restored files',
  },
  'Saving recovery manifest': {
    groupId: 'manifest',
    nowLabel: 'Recording restored files',
    nextHint: 'Recovery review',
  },
  'Collecting YMB temp artifacts': {
    groupId: 'write',
    nowLabel: 'Finding temporary files',
    nextHint: 'Removing temporary files',
  },
  'Removing YMB temp artifacts': {
    groupId: 'write',
    nowLabel: 'Removing temporary file',
    nextHint: 'Cleanup review',
  },
};

function reportOverride(
  message: string,
  nowLabel: string,
  nextHint: string,
): Record<string, ProgressStageMapping> {
  return { [message]: { groupId: 'report', nowLabel, nextHint } };
}

function createProgressModel(
  groups: ProgressGroup[],
  overrides?: Record<string, ProgressStageMapping>,
): ProgressModel {
  const mappings = overrides ? { ...BASE_STAGE_MAPPINGS, ...overrides } : BASE_STAGE_MAPPINGS;
  // Snapshots are rebuilt on every animation frame, so the per-group message
  // order is grouped once here instead of re-scanning the mapping table.
  const messagesByGroupId: Record<string, string[]> = {};
  for (const [message, mapping] of Object.entries(mappings)) {
    const groupMessages = messagesByGroupId[mapping.groupId] ?? [];
    groupMessages.push(message);
    messagesByGroupId[mapping.groupId] = groupMessages;
  }
  return { groups, mappings, messagesByGroupId };
}

export function getProgressModel(commandName: ProgressCommandName): ProgressModel {
  switch (commandName) {
    case 'validate':
      return createProgressModel(PROGRESS_GROUPS.planningValidationMaterialization);
    case 'list':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportCatalog,
        reportOverride(
          'Preparing mod project list',
          'Finding mod projects',
          'Reading project settings',
        ),
      );
    case 'find':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportMatches,
        reportOverride('Searching game files', 'Searching game file', 'Listing matches'),
      );
    case 'explain':
      return createProgressModel(
        PROGRESS_GROUPS.planningReportSelection,
        reportOverride(
          'Explaining selected patches',
          'Checking patch selection',
          'Listing selection reasons',
        ),
      );
    case 'doctor':
      // `doctor` plans first, then reads the sync manifest and compares it with
      // disk, so the second stage is the installed-state check.
      return createProgressModel(
        PROGRESS_GROUPS.planningReportPaths,
        reportOverride('Checking installed state', 'Checking last sync', 'Comparing tracked files'),
      );
    case 'build':
      return createProgressModel(PROGRESS_GROUPS.planningMaterializationWrite);
    case 'sync':
      return createProgressModel(PROGRESS_GROUPS.planningTrackedMaterializationWriteManifest);
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
  const fallbackGroup = model.groups[0] ?? { id: 'boot', label: 'Starting' };
  const currentGroupId = stage?.groupId ?? fallbackGroup.id;
  const groupIndex = Math.max(
    0,
    model.groups.findIndex((group) => group.id === currentGroupId),
  );
  const groupLabel = model.groups[groupIndex]?.label ?? fallbackGroup.label;
  const groupMessages = model.messagesByGroupId[currentGroupId] ?? [];
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
    groupId: currentGroupId,
    groupIndex,
    groupCount,
    groupLabel,
    nowLine: formatCurrentProgressLine(
      stage?.nowLabel ?? event.message,
      stage?.activityLabel,
      event,
    ),
    nextLine: `next ${nextHint}`,
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
