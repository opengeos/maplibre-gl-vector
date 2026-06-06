import { describe, it, expect } from 'vitest';
import {
  clamp,
  formatNumericValue,
  generateId,
  classNames,
} from '../src/lib/utils/helpers';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('clamps to minimum when value is too low', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });

  it('clamps to maximum when value is too high', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it('handles edge cases at boundaries', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(0, -10, -1)).toBe(-1);
    expect(clamp(-15, -10, -1)).toBe(-10);
  });
});

describe('formatNumericValue', () => {
  it('formats integers with step of 1', () => {
    expect(formatNumericValue(5, 1)).toBe('5');
    expect(formatNumericValue(100, 1)).toBe('100');
  });

  it('formats decimals based on step size', () => {
    expect(formatNumericValue(0.5, 0.1)).toBe('0.5');
    expect(formatNumericValue(0.55, 0.01)).toBe('0.55');
    expect(formatNumericValue(0.555, 0.001)).toBe('0.555');
  });

  it('handles step of 0', () => {
    expect(formatNumericValue(5, 0)).toBe('5');
  });

  it('rounds to appropriate decimal places', () => {
    expect(formatNumericValue(0.12345, 0.01)).toBe('0.12');
    expect(formatNumericValue(0.999, 0.1)).toBe('1.0');
  });
});

describe('generateId', () => {
  it('generates unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it('generates IDs with prefix', () => {
    const id = generateId('control');
    expect(id.startsWith('control-')).toBe(true);
  });

  it('generates IDs without prefix', () => {
    const id = generateId();
    expect(id).not.toContain('-');
  });
});

describe('classNames', () => {
  it('returns active class names', () => {
    expect(classNames({ active: true, disabled: false })).toBe('active');
    expect(classNames({ active: true, visible: true })).toBe('active visible');
  });

  it('returns empty string when no classes are active', () => {
    expect(classNames({ active: false, disabled: false })).toBe('');
  });

  it('handles all classes active', () => {
    expect(classNames({ a: true, b: true, c: true })).toBe('a b c');
  });
});
