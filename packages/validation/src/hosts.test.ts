import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  isReservedSubdomain,
  normalizeHostname,
  platformAdminHostname,
} from './hosts.js';

describe('normalizeHostname', () => {
  it('lower-cases and strips the port', () => {
    expect(normalizeHostname('Admin.LocalHost:3000')).toBe('admin.localhost');
  });

  it('strips one trailing dot (absolute DNS form)', () => {
    expect(normalizeHostname('clinic.localhost.')).toBe('clinic.localhost');
  });

  it('keeps a bracketed IPv6 literal without its port', () => {
    expect(normalizeHostname('[::1]:3000')).toBe('[::1]');
  });

  it('returns an empty string for empty or missing input', () => {
    expect(normalizeHostname('')).toBe('');
    expect(normalizeHostname('   ')).toBe('');
    expect(normalizeHostname(null)).toBe('');
    expect(normalizeHostname(undefined)).toBe('');
  });
});

describe('classifyHost (root domain: localhost)', () => {
  it('recognizes the platform admin origin', () => {
    expect(classifyHost('admin.localhost', 'localhost')).toEqual({ kind: 'platform' });
    expect(classifyHost('admin.localhost:3000', 'localhost')).toEqual({ kind: 'platform' });
  });

  it('recognizes a tenant origin and extracts the slug', () => {
    expect(classifyHost('clinic.localhost', 'localhost')).toEqual({
      kind: 'tenant',
      slug: 'clinic',
    });
    expect(classifyHost('CLINIC.localhost:3000', 'localhost')).toEqual({
      kind: 'tenant',
      slug: 'clinic',
    });
  });

  it('recognizes the root origin', () => {
    expect(classifyHost('localhost', 'localhost')).toEqual({ kind: 'root' });
    expect(classifyHost('localhost:3000', 'localhost')).toEqual({ kind: 'root' });
  });
});

describe('classifyHost (root domain: example.com)', () => {
  it('classifies admin, tenant and root under a real root domain', () => {
    expect(classifyHost('admin.example.com', 'example.com')).toEqual({ kind: 'platform' });
    expect(classifyHost('clinic.example.com', 'example.com')).toEqual({
      kind: 'tenant',
      slug: 'clinic',
    });
    expect(classifyHost('example.com', 'example.com')).toEqual({ kind: 'root' });
  });

  it('treats reserved labels as non-tenants', () => {
    expect(classifyHost('www.example.com', 'example.com')).toEqual({ kind: 'external' });
    expect(classifyHost('api.example.com', 'example.com')).toEqual({ kind: 'external' });
    expect(classifyHost('panel.example.com', 'example.com')).toEqual({ kind: 'external' });
  });

  it('rejects lookalike and out-of-scheme hosts', () => {
    expect(classifyHost('evil-example.com', 'example.com')).toEqual({ kind: 'external' });
    expect(classifyHost('clinic.example.com.evil.com', 'example.com')).toEqual({
      kind: 'external',
    });
    expect(classifyHost('deep.clinic.example.com', 'example.com')).toEqual({ kind: 'external' });
    expect(classifyHost('admin.localhost', 'example.com')).toEqual({ kind: 'external' });
  });

  it('rejects labels that are not valid slugs', () => {
    expect(classifyHost('clinic_shop.example.com', 'example.com')).toEqual({
      kind: 'external',
    });
    expect(classifyHost('-clinic.example.com', 'example.com')).toEqual({ kind: 'external' });
  });

  it('fails closed on empty input on either side', () => {
    expect(classifyHost('', 'example.com')).toEqual({ kind: 'external' });
    expect(classifyHost('clinic.example.com', '')).toEqual({ kind: 'external' });
  });
});

describe('isReservedSubdomain', () => {
  it('flags every reserved label and nothing else', () => {
    expect(isReservedSubdomain('admin')).toBe(true);
    expect(isReservedSubdomain('www')).toBe(true);
    expect(isReservedSubdomain('API')).toBe(true);
    expect(isReservedSubdomain('panel')).toBe(true);
    expect(isReservedSubdomain('clinic')).toBe(false);
  });
});

describe('platformAdminHostname', () => {
  it('composes the platform origin from the root domain', () => {
    expect(platformAdminHostname('localhost')).toBe('admin.localhost');
    expect(platformAdminHostname('example.com')).toBe('admin.example.com');
    expect(platformAdminHostname('Example.COM:443')).toBe('admin.example.com');
  });

  it('falls back to the bare label when no root domain is given', () => {
    expect(platformAdminHostname('')).toBe('admin');
  });
});
