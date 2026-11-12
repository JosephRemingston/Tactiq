# Security audit summary

**Scope:** the whole repository: the Express API, Netlify function, worker, admin CLI, database schema and migrations, CI workflows and dependencies.

**Date:** 12 November 2026.

**Method:**
1. Read every route, middleware, service, job and query, and traced each route end to end.
2. Built a threat model.
3. Reproduced each suspected vulnerability against a running instance on a local database.
4. Fixed the confirmed vulnerabilities, each with a regression test.
5. Re-ran the attacks to confirm the fixes, and temporarily removed key fixes to confirm their tests fail without them.
6. Built an automated test suite and CI security gates.

No production system was tested: Neon, Upstash, Clerk and Google were not touched.

## Overall assessment

Before the audit, the application had **one High-severity flaw** that converts directly into lost revenue: one purchase could unlock Pro for any number of accounts. It also had a set of **Medium-severity weaknesses**:
- wrong revocations on refunds
- deleted personal data coming back
- charges for failed requests
- rate limits that switched off without Redis
- private data copied into logs
- input that crashed queries
- CI workflows with weak isolation of production secrets

The core design was sound:
- Ownership was enforced in every private query: no IDOR/BOLA was found.
- There is no HTTP admin surface.
- All SQL is parameterised: no injection was found.
- JWT verification resisted every forgery tried.
- Paywall limits are enforced on the server with row locking.

**All confirmed Critical, High and Medium findings are fixed and covered by regression tests.** The residual risk is **Low to Medium** and is mostly operational: the items in `REMAINING_RISKS.md` need a deployment, credentials or a product decision.

| Severity | Found | Fixed | Accepted / open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 1 | 1 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 10 | 10 | 0 |
| Informational | 4 | 2 | 2 (accepted) |

## Test suite

| | Before | After |
|---|---|---|
| Tests | 65 | **229** (164 added) |
| Passing / failing / skipped | 65 / 0 / 0 | **229 / 0 / 0** |
| Line / branch coverage | not measured | **96.5% / 85.5%** |
| Routes covered | 22 | **70 / 70** |

Details are in `TEST_COVERAGE.md`. Branch coverage is below the 90% target on seven security-critical modules (77–88%), as noted there.

## Scanner results (run on the final code)

| Check | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** in production dependencies |
| `npm audit --audit-level=critical` | Pass. 4 moderate advisories, all in the dev-only `drizzle-kit` → esbuild chain (GHSA-67mh-4wv8-2f99), not shipped |
| Gitleaks v8.30.1, full git history (8 commits, 17.8 MB) | **No leaks.** 35 false positives (public StatsBomb UUIDs, metric keys) are handled by two line-shaped allowlist rules; a planted canary secret is still detected |
| Gitleaks, committed tree | No leaks |
| Semgrep 1.184.0 (JavaScript, Node.js, Express, OWASP Top 10, JWT, secrets; 159 files) | **ERROR gate: 0 findings.** Before the fixes: 1 ERROR (`run-shell-injection` in the jobs workflow) and 4 WARNING (mutable action tags). Remaining non-blocking matches are reviewed false positives: SHA-1 required by UUIDv5, SHA-1 used as a local-file ETag, `Math.random` for retry jitter, a literal regex flagged as ReDoS, `x-powered-by` already disabled, and a CSP info note |
| OWASP ZAP baseline | **Not run.** There is no staging deployment yet (R-11) |
| Attack-category tests | All pass (see `TEST_COVERAGE.md`): authentication forgery (13 kinds), BOLA/IDOR/BFLA, SQL injection with timing checks, XSS storage, validation and fuzzing, billing fraud and races, paywall bypass and races, webhook forgery, replay and ordering, rate-limit bypass, job concurrency and crash recovery, dependency failures |

## Commands

```sh
# Disposable local database (Docker), once
docker run -d --name touchline-test-pg -e POSTGRES_USER=touchline -e POSTGRES_PASSWORD=touchline -e POSTGRES_DB=touchline_test -p 5432:5432 postgres:17-alpine

# Full suite / with coverage
TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_test npm test
TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_test npm run test:coverage

# Unit tests only (no database needed)
npm test

# Security checks (Gitleaks and Semgrep need Docker)
npm run security:audit
npm run security:secrets
npm run security:sast

# Reproduce a fuzz run with other inputs
FUZZ_SEED=12345 TEST_DATABASE_URL=… npm test
```

In CI:
- `.github/workflows/tests.yml` runs the suite with coverage against a Postgres service, on every push and pull request.
- `.github/workflows/security.yml` runs the audit, Gitleaks and Semgrep on every push, every pull request and weekly.

Neither workflow uses production secrets.

## Documents in this folder

- `ARCHITECTURE_INVENTORY.md`: every endpoint, middleware chain, job, integration, table, sensitive datum and environment variable
- `THREAT_MODEL.md`: assets, trust boundaries, attackers, attack paths and their status
- `SECURITY_FINDINGS.md`: the vulnerability register (F-01 to F-22)
- `REMEDIATION_LOG.md`: every change and its reason
- `TEST_COVERAGE.md`: numbers, per-suite coverage and gaps
- `REMAINING_RISKS.md`: open items with the exact action each one needs
