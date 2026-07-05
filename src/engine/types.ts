import type { PatchApplication, PatchTarget } from '../types.ts';

export interface ResolvedPatchContribution {
  application: PatchApplication;
  target: PatchTarget;
  targetRelativePath: string;
  hasScripts: boolean;
  patchOrder: number;
}
