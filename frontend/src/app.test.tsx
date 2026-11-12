// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CHECKS, MissingKey } from './App';
import { decodeJwt, tamper } from './jwt';

// Real JWT segments are base64url of UTF-8 bytes.
const b64 = (o: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64({ alg: 'RS256', kid: 'ins_1' })}.${b64({ sub: 'user_1', sid: 'sess_1', sts: 'active', name: 'Ünïcode' })}.c2ln`;

describe('jwt helpers', () => {
  it('decodes header and claims, including UTF-8', () => {
    const d = decodeJwt(token)!;
    expect(d.header.kid).toBe('ins_1');
    expect(d.claims).toMatchObject({ sub: 'user_1', sts: 'active', name: 'Ünïcode' });
    expect(decodeJwt('not-a-jwt')).toBeNull();
  });
  it('tampering keeps header and claims but breaks the signature', () => {
    const t = tamper(token);
    expect(t.split('.').slice(0, 2)).toEqual(token.split('.').slice(0, 2));
    expect(t.split('.')[2]).not.toBe(token.split('.')[2]);
  });
});

describe('page', () => {
  it('explains setup when the Clerk key is missing', () => {
    render(<MissingKey />);
    expect(screen.getByText(/Clerk is not configured/)).toBeTruthy();
  });
  it('defines positive and negative backend checks', () => {
    expect(CHECKS.filter((c) => c.expect === 401).map((c) => c.id)).toEqual(['anon', 'tampered']);
  });
});
