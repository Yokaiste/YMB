import type { PatchApplication, PatchNotice } from '../../types.ts';
import { toPatchErrorIdentity } from './shared.ts';

/**
 * A field left alone because it already held the new value looks exactly like a
 * target nobody touched, so the operation says so as it happens and the command
 * decides how to show it.
 */
export type PatchNoticeSink = (notice: PatchNotice) => void;

/** Values belong in the file. A terminal line only needs enough to recognise one. */
const MAX_REPORTED_VALUE_LENGTH = 60;

export function createPatchNotice(
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  reason: string,
  suggestion: string,
): PatchNotice {
  return {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason,
    suggestion,
  };
}

/** One line, short enough to read, and recognisable as the value in the file. */
export function describeNdfValue(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_REPORTED_VALUE_LENGTH
    ? `${flattened.slice(0, MAX_REPORTED_VALUE_LENGTH)}...`
    : flattened;
}

export function reportValueAlreadySet(
  onNotice: PatchNoticeSink | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  targetLabel: string,
  value: string,
): void {
  reportPatchNotice(
    onNotice,
    application,
    absolutePath,
    operationIndex,
    `\`${targetLabel}\` is already \`${describeNdfValue(value)}\`, so this operation changed nothing.`,
    'Delete the operation if it is finished, or set the value you actually want.',
  );
}

/** A `remove` that found nothing to remove. The file already says what it asked for. */
export function reportTargetAlreadyGone(
  onNotice: PatchNoticeSink | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  missingReason: string,
): void {
  reportPatchNotice(
    onNotice,
    application,
    absolutePath,
    operationIndex,
    `${missingReason} There was nothing to remove.`,
    'Delete the operation if the game no longer ships this, or fix the selector if it should still match.',
  );
}

/** An `add` or `copy` whose result is already in the file, byte for byte. */
export function reportTargetAlreadyPresent(
  onNotice: PatchNoticeSink | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  targetLabel: string,
): void {
  reportPatchNotice(
    onNotice,
    application,
    absolutePath,
    operationIndex,
    `${targetLabel} is already in this file, so this operation added nothing.`,
    'Delete the operation if the game already ships this, or change what it adds.',
  );
}

function reportPatchNotice(
  onNotice: PatchNoticeSink | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  reason: string,
  suggestion: string,
): void {
  onNotice?.(createPatchNotice(application, absolutePath, operationIndex, reason, suggestion));
}
