// Minimal zero-dependency assertion helper for the smoke suite.
export function suite(name) {
  const checks = [];
  const push = (n, ok, detail) => checks.push({ name: n, ok: !!ok, detail: ok ? "" : String(detail ?? "") });
  return {
    name,
    checks,
    ok(n, cond, detail = "assertion failed") { push(n, cond, detail); return cond; },
    eq(n, got, want) {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      push(n, ok, `got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`);
      return ok;
    },
    throws(n, fn) { let threw = false; try { fn(); } catch { threw = true; } push(n, threw, "expected a throw"); return threw; },
  };
}

// Render a list of suites; returns true if all passed.
export function report(suites) {
  let total = 0, failed = 0;
  for (const s of suites) {
    const f = s.checks.filter(c => !c.ok);
    total += s.checks.length; failed += f.length;
    const mark = f.length ? "✗" : "✓";
    console.log(`\n${mark} ${s.name}  (${s.checks.length - f.length}/${s.checks.length})`);
    for (const c of s.checks) console.log(`   ${c.ok ? "·" : "FAIL"} ${c.name}${c.ok ? "" : "  → " + c.detail}`);
  }
  console.log(`\n${failed ? "❌" : "✅"} smoke: ${total - failed}/${total} checks passed${failed ? `, ${failed} FAILED` : ""}`);
  return failed === 0;
}
