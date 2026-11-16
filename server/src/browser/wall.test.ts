import { describe, expect, it } from 'vitest';
import { wallState } from './wall';

const look = (o: Partial<Parameters<typeof wallState>[0]>) => ({ title: '', text: '', markers: [], ...o });

describe('wallState', () => {
  it('tells a self-clearing interstitial from a challenge a person answers', () => {
    expect(wallState(look({ title: 'Just a moment...', text: 'Checking your browser' }))).toBe('checking');
    expect(wallState(look({ markers: ['cfRunning'], text: 'Performing security verification' }))).toBe(
      'checking',
    );
    expect(wallState(look({ title: 'Just a moment...', markers: ['cfRunning', 'turnstile'] }))).toBe('check');
    expect(wallState(look({ markers: ['recaptcha'], text: 'Verify you are human' }))).toBe('check');
    expect(wallState(look({ markers: ['pressHold'], text: 'Press & Hold' }))).toBe('check');
  });

  it('reads a refusal as blocked', () => {
    expect(wallState(look({ title: 'Access denied', text: 'You do not have access' }))).toBe('blocked');
    expect(wallState(look({ status: 429, text: 'Too many requests' }))).toBe('blocked');
  });

  it('leaves ordinary pages alone, a long form with a reCAPTCHA at its foot too', () => {
    expect(wallState(look({ title: 'News', text: 'Today…' }))).toBe('clear');
    expect(wallState(look({ title: 'Sign up', text: 'x'.repeat(3000), markers: ['recaptcha'] }))).toBe(
      'clear',
    );
    expect(wallState(look({ title: 'Docs: Forbidden errors', text: 'x'.repeat(3000), status: 200 }))).toBe(
      'clear',
    );
  });
});
