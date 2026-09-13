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
  /** Messages per group in mapping order, precomputed for per-frame snapshots. */
  messagesByGroupId: Record<string, string[]>;
}

export interface ProgressSnapshot {
  overallFraction: number;
  groupId: string;
  groupIndex: number;
  groupCount: number;
  groupLabel: string;
  nowLine: string;
  nextLine: string;
  current?: number | undefined;
  total?: number | undefined;
}

/**
 * Declared rather than inferred: the live and plain renderers are separate
 * implementations of the same contract, and an inferred return type would let
 * one of them quietly grow or lose a method.
 */
export interface ProgressDisplay {
  update(event: ProgressDisplayEvent): void;
  stop(status: 'done' | 'failed'): void;
}
