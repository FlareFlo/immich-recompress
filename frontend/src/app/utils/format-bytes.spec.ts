import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('formats zero and positive byte counts cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GB');
  });
});
