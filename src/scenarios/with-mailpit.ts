import { makeServiceScenario } from '../lib/service-scenario.js';

// mailpit: SMTP catcher. Asserts MAILPIT_HOST/PORT, sends a mail over
// SMTP, and verifies it via the Mailpit API.
export const withMailpit = makeServiceScenario({
  id: 'with-mailpit',
  service: 'mailpit',
  port: 1025,
  probeScript: 'mail-client.mjs',
  probeLabel: 'mailpit',
  estimatedSeconds: 120,
});
