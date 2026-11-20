import { describe, expect, it } from 'vitest';
import { deviceName } from './device';

describe('cihaz adı', () => {
  it('tarayıcıyı ve işletim sistemini tanır', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      ),
    ).toEqual({ app: 'Chrome', os: 'macOS' });
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0',
      ),
    ).toEqual({ app: 'Edge', os: 'Windows' });
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      ),
    ).toEqual({ app: 'Safari', os: 'iOS' });
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Electron/38.0 Safari/537.36')).toEqual({
      app: 'Leaf Bot',
      os: 'Linux',
    });
    expect(deviceName(null)).toEqual({ app: null, os: null });
    expect(deviceName('curl/8.0')).toEqual({ app: null, os: null });
  });
});
