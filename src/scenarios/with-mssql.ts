import { makeServiceScenario } from '../lib/service-scenario.js';

// mssql: asserts MSSQL_URL/HOST/PORT/USER/PASSWORD/DB, then a #temp-table
// round-trip via the `mssql` driver in the database the healthcheck creates.
// The image is amd64-only; the runner is amd64, so it runs natively here.
export const withMssql = makeServiceScenario({
  id: 'with-mssql',
  service: 'mssql',
  port: 1433,
  probeScript: 'mssql-client.mjs',
  probeLabel: 'mssql',
  estimatedSeconds: 180,
});
