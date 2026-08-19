import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const textEncoder = new TextEncoder();

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash a file without retaining its complete contents in memory. */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Encoding a string to bytes first gives the same answer, but allocates a second full
 * copy of a file that can be tens of megabytes instead of streaming it.
 */
export function hashContent(content: string | Uint8Array): string {
  return typeof content === 'string' ? hashText(content) : hashBytes(content);
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? textEncoder.encode(content) : content;
}
