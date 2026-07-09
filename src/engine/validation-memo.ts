import type { CooperativeYieldController } from '../async.ts';
import { validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import { hashText } from './shared.ts';

const MEMO_CAPACITY = 256;

const validatedContentHashes = new Set<string>();

export function validateNdfMemoized(text: string, absolutePath: string): void {
  const contentHash = hashText(text);
  if (validatedContentHashes.has(contentHash)) {
    return;
  }
  validateNdf(text, absolutePath);
  rememberValidated(contentHash);
}

export async function validateNdfMemoizedCooperative(
  text: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  const contentHash = hashText(text);
  if (validatedContentHashes.has(contentHash)) {
    return;
  }
  await validateNdfCooperative(text, absolutePath, yieldController);
  rememberValidated(contentHash);
}

export function resetValidationMemoForTests(): void {
  validatedContentHashes.clear();
}

function rememberValidated(contentHash: string): void {
  if (validatedContentHashes.size >= MEMO_CAPACITY) {
    const oldest = validatedContentHashes.values().next().value;
    if (oldest !== undefined) {
      validatedContentHashes.delete(oldest);
    }
  }
  validatedContentHashes.add(contentHash);
}
