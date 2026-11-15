import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'computer', include: ['test/**/*.test.ts'] } });
