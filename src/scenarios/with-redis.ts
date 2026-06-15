import { makeServiceScenario } from '../lib/service-scenario.js';

// redis: asserts REDIS_URL, then a set/get/del round-trip via node-redis.
export const withRedis = makeServiceScenario({
  id: 'with-redis',
  service: 'redis',
  port: 6379,
  probeScript: 'redis-client.mjs',
  probeLabel: 'redis',
  estimatedSeconds: 120,
});
