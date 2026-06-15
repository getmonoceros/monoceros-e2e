import { makeServiceScenario } from '../lib/service-scenario.js';

// rustfs: S3-compatible storage. Asserts RUSTFS_URL/ACCESS_KEY/SECRET_KEY,
// then create-bucket/put/get/delete via the AWS SDK (path-style).
export const withRustfs = makeServiceScenario({
  id: 'with-rustfs',
  service: 'rustfs',
  port: 9000,
  probeScript: 's3-client.mjs',
  probeLabel: 'rustfs S3',
  estimatedSeconds: 150,
});
