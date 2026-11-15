import { defineProject } from 'vitest/config';

// Only the pure logic is tested here; screens need React Native and run in the simulator.
export default defineProject({ test: { name: 'native', include: ['src/lib/**/*.test.ts'] } });
