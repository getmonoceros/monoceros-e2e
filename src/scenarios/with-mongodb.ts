import { makeServiceScenario } from '../lib/service-scenario.js';

// mongodb: asserts MONGODB_URL, then insert/find/delete via the driver.
export const withMongodb = makeServiceScenario({
  id: 'with-mongodb',
  service: 'mongodb',
  port: 27017,
  probeScript: 'mongo-client.mjs',
  probeLabel: 'mongodb',
  estimatedSeconds: 150,
});
