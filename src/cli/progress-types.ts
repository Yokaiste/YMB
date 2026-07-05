import type { CliCommandName } from '../cli-guide.ts';

export type ProgressCommandName = Exclude<CliCommandName, 'init'>;

export interface ProgressDisplayEvent {
  message: string;
  detail?: string | undefined;
  current?: number | undefined;
  total?: number | undefined;
}

export interface ProgressStageMapping {
  groupId: string;
  nowLabel: string;
  activityLabel?: string | undefined;
  nextHint?: string | undefined;
}

export interface ProgressGroup {
  id: string;
  label: string;
}

export interface ProgressModel {
  groups: ProgressGroup[];
  mappings: Record<string, ProgressStageMapping>;
}

export interface ProgressSnapshot {
  overallFraction: number;
  groupLabel: string;
  nowLine: string;
  nextLine: string;
  current?: number | undefined;
  total?: number | undefined;
}

export interface ProgressEtaPhaseState {
  message: string;
  total: number;
  current: number;
  itemStartedAt: number;
  averageItemDurationMs?: number | undefined;
}
