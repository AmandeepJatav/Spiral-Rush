/* ============================================================
   SPIRAL RUSH — test runner
   File: test/run.js   (npm test)
   ------------------------------------------------------------
   Runs unit + integration suites, prints a summary, exits non-zero
   on any failure (CI-friendly).
   ============================================================ */
'use strict';
const { runUnit } = require('./unit.test');
const { runIntegration } = require('./integration.test');

(async () => {
  console.log('\n=== UNIT TESTS ===');
  const u = runUnit();
  console.log(`  ${u.pass} passed, ${u.fail} failed`);

  console.log('\n=== INTEGRATION + ADVERSARIAL TESTS ===');
  const i = await runIntegration();
  console.log(`  ${i.pass} passed, ${i.fail} failed`);

  const pass = u.pass + i.pass, fail = u.fail + i.fail;
  console.log('\n========================================');
  console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); [...u.fails, ...i.fails].forEach(f => console.log('  - ' + f)); }
  console.log(fail ? '❌ TESTS FAILED' : '✅ ALL TESTS PASSED');
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})();
