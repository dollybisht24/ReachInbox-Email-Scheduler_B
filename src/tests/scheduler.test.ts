import { getHourBucket, getMsUntilNextHourWindow } from '../services/rateLimiter';
import { signSessionToken, verifySessionToken } from '../services/authService';

describe('Scheduler & Rate Limiter Utilities', () => {
  test('getHourBucket returns consistent hourly integer', () => {
    const fixedDate = new Date('2026-10-29T10:15:30.000Z');
    const bucket = getHourBucket(fixedDate);
    const expected = Math.floor(fixedDate.getTime() / 3600000);
    expect(bucket).toBe(expected);

    // Another date within the same hour returns the exact same bucket
    const sameHourDate = new Date('2026-10-29T10:45:00.000Z');
    expect(getHourBucket(sameHourDate)).toBe(bucket);

    // An hour later returns bucket + 1
    const nextHourDate = new Date('2026-10-29T11:00:00.000Z');
    expect(getHourBucket(nextHourDate)).toBe(bucket + 1);
  });

  test('getMsUntilNextHourWindow calculates positive delay until next window', () => {
    const testDate = new Date('2026-10-29T10:30:00.000Z');
    const delay = getMsUntilNextHourWindow(testDate);
    // At 10:30, 30 minutes remain (1,800,000 ms) + 1-5s jitter
    expect(delay).toBeGreaterThanOrEqual(1800000);
    expect(delay).toBeLessThan(1800000 + 10000);
  });

  test('Auth session JWT signing and verification', () => {
    const payload = {
      userId: 'test-user-123',
      email: 'alex@reachinbox.test',
      name: 'Alex Reviewer',
    };

    const token = signSessionToken(payload);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const decoded = verifySessionToken(token);
    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.name).toBe(payload.name);
  });

  test('Invalid session JWT throws error', () => {
    expect(() => verifySessionToken('invalid.jwt.token')).toThrow();
  });
});
