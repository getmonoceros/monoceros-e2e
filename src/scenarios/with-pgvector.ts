import { makeServiceScenario } from '../lib/service-scenario.js';

// pgvector: a drop-in Postgres with the `vector` extension. The probe
// asserts PGVECTOR_URL, enables the extension, and runs a
// nearest-neighbour query.
export const withPgvector = makeServiceScenario({
  id: 'with-pgvector',
  service: 'pgvector',
  port: 5432,
  probeScript: 'pgvector-client.mjs',
  probeLabel: 'pgvector',
  estimatedSeconds: 150,
});
