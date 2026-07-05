import type { ExpressionNode } from './types.ts';

export function coerceNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Template expression expected a number for ${label}.`);
}

export function coerceComparable(value: unknown, label: string): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Template expression expected a string or number for ${label}.`);
}

export function coerceArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`Template expression expected an array for ${label}.`);
}

export function asInteger(value: unknown, label: string): number {
  const normalized = coerceNumber(value, label);
  if (!Number.isInteger(normalized)) {
    throw new Error(`Template expression expected an integer for ${label}.`);
  }
  return normalized;
}

export function asNonNegativeInteger(value: unknown, label: string): number {
  const normalized = asInteger(value, label);
  if (normalized < 0) {
    throw new Error(`Template expression expected a non-negative integer for ${label}.`);
  }
  return normalized;
}

export function readMemberValue(target: unknown, property: unknown): unknown {
  if (Array.isArray(target)) {
    const index = asNonNegativeInteger(property, 'array index');
    if (index >= target.length) {
      throw new Error(`Template expression array index ${index} is out of range.`);
    }
    return target[index];
  }

  if (typeof target === 'string') {
    const index = asNonNegativeInteger(property, 'string index');
    if (index >= target.length) {
      throw new Error(`Template expression string index ${index} is out of range.`);
    }
    return target[index];
  }

  if (target && typeof target === 'object') {
    const key = normalizeObjectKey(property);
    if (!(key in target)) {
      throw new Error(`Template expression object has no property \`${key}\`.`);
    }
    return (target as Record<string, unknown>)[key];
  }

  throw new Error('Template expression expected an array, string, or object for member access.');
}

export function expressionValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Number.isNaN(left) && Number.isNaN(right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => expressionValuesEqual(entry, right[index]))
    );
  }

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(
        ([key, value]) =>
          key in (right as Record<string, unknown>) &&
          expressionValuesEqual(value, (right as Record<string, unknown>)[key]),
      )
    );
  }

  return false;
}

export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled template expression operator: ${String(value)}`);
}

export type BinaryExpressionNode = Extract<ExpressionNode, { kind: 'binary' }>;
export type CallExpressionNode = Extract<ExpressionNode, { kind: 'call' }>;
export type MemberExpressionNode = Extract<ExpressionNode, { kind: 'member' }>;

function normalizeObjectKey(property: unknown): string {
  if (typeof property === 'string' || typeof property === 'number') {
    return String(property);
  }
  throw new Error('Template expression expected a string or number for an object property name.');
}
