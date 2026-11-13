import { createHash } from 'node:crypto';
import { splitTrailingComment } from './comments.ts';
import { findAllNestedFieldRanges } from './scan.ts';

/** Copy identities are stable across machines and rebuilds; other GUID-valued fields are references. */
export function reidentifyDescriptorIds(text: string, namespace: string): string {
  const occurrences = new Map<string, number>();
  const parts: string[] = [];
  let cursor = 0;
  for (const field of findAllNestedFieldRanges(text, 'DescriptorId')) {
    const raw = text.slice(field.valueStart, field.valueEnd);
    const code = splitTrailingComment(raw).code;
    const literal = code.trim();
    const match = /^GUID:\{([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\}$/i.exec(literal);
    if (!match?.[1]) continue;
    const original = match[1].toLowerCase();
    const occurrence = occurrences.get(original) ?? 0;
    occurrences.set(original, occurrence + 1);
    const bytes = createHash('sha256')
      .update(JSON.stringify([namespace, original, occurrence]))
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const start = field.valueStart + code.indexOf(literal);
    parts.push(text.slice(cursor, start), `GUID:{${guid}}`);
    cursor = start + literal.length;
  }
  if (cursor === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}
