import { describe, expect, it } from 'vitest';
import { runCommand } from './RoutineDialog';

describe('rutin çalıştırma komutu', () => {
  it('anahtarı ortamdan okur, komuta yazmaz', () => {
    const cmd = runCommand('https://yumakbot.example', 'r1');
    expect(cmd).toContain("curl -X POST 'https://yumakbot.example/api/routines/r1/run'");
    expect(cmd).toContain('Bearer $YUMAKBOT_ACCESS_KEY');
    expect(cmd.split('\n')).toHaveLength(4);
  });
});
