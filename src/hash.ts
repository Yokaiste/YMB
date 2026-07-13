import { createHash } from 'node:crypto';

const textEncoder = new TextEncoder();

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? textEncoder.encode(content) : content;
}
