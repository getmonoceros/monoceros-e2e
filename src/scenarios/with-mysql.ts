import { makeServiceScenario } from '../lib/service-scenario.js';

// mysql: asserts MYSQL_URL, then a temp-table CRUD round-trip via mysql2.
export const withMysql = makeServiceScenario({
  id: 'with-mysql',
  service: 'mysql',
  port: 3306,
  probeScript: 'mysql-client.mjs',
  probeLabel: 'mysql',
  estimatedSeconds: 150,
});
