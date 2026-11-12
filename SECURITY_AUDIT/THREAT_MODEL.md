# Threat model

This threat model uses the OWASP Top 10 (2021), the OWASP API Security Top 10 (2023) and CWE as references. Severities follow `SECURITY_FINDINGS.md`.

## 1. Assets

| Asset | Why it matters | Where |
|---|---|---|
| Pro entitlements and revenue | Fraud converts directly into lost revenue | entitlements, subscriptions, purchases |
| User private data (notes, saves, follows, learning) | Privacy and trust; personal data under DPDP and GDPR-style law | user_* tables |
| Identity data (email, name, avatar, Clerk id, IPs) | Personal data | users, user_identities, security_events |
| Purchase tokens and raw store responses | Can be replayed against the store; financial records | purchases, billing_notifications |
| Credentials (Neon, Upstash, storage, Clerk, Google service account, webhook secrets) | Full compromise | Netlify and GitHub secret stores, local `.env` |
| Shared football data and analysis | Integrity of the product; licensed data | events, tactical_metrics, insights, object storage |
| Availability of the API and the job pipeline | Free-tier quotas (Neon, Upstash, Actions) can be exhausted | All |

## 2. Trust boundaries

```
 Internet ──(1)──▶ Netlify edge ──(2)──▶ Netlify Function (Express API) ──(3)──▶ Neon Postgres
    │                                         │  ├──(4)──▶ Upstash Redis (REST)
    │                                         │  ├──(5)──▶ Clerk API (sessions, users)
    │                                         │  └──(6)──▶ Google Play Developer API
 Clerk/Svix ─(7)─▶ webhook route              │
 Google Pub/Sub ─(8)─▶ RTDN route              │
 GitHub Actions worker ──(9)──▶ Neon, object storage, StatsBomb (10)
 Developer laptop / CLI ──(11)──▶ Neon (full privileges)
```

| # | Boundary | What crosses it | Trust |
|---|---|---|---|
| 1 | Client → edge | Every request | Untrusted |
| 2 | Edge → function | Client IP header set by Netlify | Trusted only on Netlify (to be verified, R-1) |
| 3 | API → Postgres | Parameterised SQL | Trusted |
| 4–6 | API → Upstash, Clerk, Google | Responses | Trusted service; responses still shape-checked |
| 7 | Svix → webhook | Signed events | Trusted after signature and timestamp checks |
| 8 | Pub/Sub → RTDN | Token in the query string | Trusted after the token check; content treated only as a hint |
| 9–10 | Worker → provider | Provider JSON | Untrusted: schema-validated |
| 11 | Operator → database | Admin CLI | Fully trusted (holds credentials) |

## 3. Entry points

- 70 HTTP route patterns (`ARCHITECTURE_INVENTORY.md`, section 3), of which 2 are webhooks.
- Provider data ingested by the worker.
- CI workflows, both those triggered by repository events and the scheduled ones.
- The admin CLI, for operators only.

## 4. Attackers

| Attacker | Capabilities | Main goals |
|---|---|---|
| Anonymous internet user | Any HTTP request, many IPs, forged headers | Scrape, crash, exhaust quotas, enumerate |
| Authenticated free user | Valid token for their own account; can script requests and run them concurrently | Unlock Pro, exceed limits, read others' data |
| Holder of a stolen Pro purchase token | A real token from a friend, a forum or a refund scam | Grant Pro to many accounts |
| Compromised account | Valid session for a victim | Read and delete the victim's data, revoke their sessions |
| Spoofed webhook sender | Can POST to the webhook URLs | Create, modify or delete accounts; grant or revoke Pro |
| Malicious or compromised data provider | Controls the JSON the worker ingests | Inject SQL, path traversal, exhaust memory |
| Malicious pull request author | Opens a PR against the repository | Steal CI secrets |
| Compromised dependency | Code runs at install time or at runtime | Steal secrets |
| Malicious insider | Holds database credentials | Anything (out of scope for app controls; mitigated only by secret hygiene and audit rows) |

## 5. Attack paths and their status

| # | Path | OWASP / CWE | Before audit | After |
|---|---|---|---|---|
| A1 | Two accounts verify one purchase token at the same moment, so both get Pro | API6 Unrestricted Access to Sensitive Business Flows / CWE-362 | **Exploitable** (F-01) | Fixed, regression test |
| A2 | Free user tampers with an id to read another user's notes or collections | API1 BOLA / CWE-639 | Not exploitable (owner-scoped queries) | Regression tests added |
| A3 | Calling an admin function over HTTP | API5 BFLA | Not exploitable (no HTTP admin surface) | Tested |
| A4 | Forged JWT (alg none, HS256 confusion, other key, tampered payload, wrong party) | A07 / CWE-347 | Not exploitable | Tested |
| A5 | Late or replayed signed webhook restores a deleted user's personal data | A04 / CWE-367 | **Exploitable** (F-03) | Fixed |
| A6 | Refund of an old order ends a paying user's subscription | A04 business logic | **Exploitable** (F-02) | Fixed |
| A7 | Free user gets charged for nothing (404/409), or squeezes extra saves through concurrency | API6 / CWE-362 | **Exploitable** (F-04, F-09) | Fixed |
| A8 | SQL injection through search, filters, cursors or ids | A03 / CWE-89 | Not exploitable (parameterised); tampered cursors caused 500s (F-05) | Fixed, fuzzed |
| A9 | Crash or 500 flood via malformed input (NUL, dates, nesting) | API4 / CWE-20 | **Exploitable** (F-05) | Fixed |
| A10 | Abuse when Redis is down, or through routes the limiter never sees | API4 Unrestricted Resource Consumption / CWE-770 | **Exploitable** (F-07, F-08) | Fixed (memory fallback, backstop) |
| A11 | Private notes and emails end up in logs through query parameters | A09 / CWE-532 | **Exploitable** (F-06) | Fixed |
| A12 | Cached private responses served to others by a shared cache | API8 / CWE-524 | Possible (no cache headers, F-13) | Fixed |
| A13 | PR or workflow injection steals production secrets | A08 / CWE-78 | Risk (no permissions block, mutable tags, `${{ }}` in shell; F-16) | Fixed |
| A14 | Provider JSON path traversal or SQL injection | A03 / CWE-22 | Not exploitable (integer ids, schemas, parameterised SQL) | Tested |
| A15 | SSRF through user-controlled URLs | API7 / CWE-918 | No surface (all outbound hosts come from the environment) | Documented |
| A16 | Forged Google notification | A07 | Mostly mitigated (token); package check was skippable (F-14) | Fixed |
| A17 | Account takeover through identity linking | A07 | Not exploitable (Clerk owns linking; local upsert never re-points an identity) | — |
| A18 | Spoofed client IP to dodge limits | API4 / CWE-348 | Mitigated (headers trusted only on Netlify or a verified edge) | Netlify behaviour to verify (R-1) |

## 6. Regression-test requirements

Every finding in `SECURITY_FINDINGS.md` lists its regression test. The rules for future changes:

1. **New private routes:** add the route to `tests/support/routes.js`. The auth and contract suites then fail until it is covered.
2. **New gated features:** add a feature key to `data/plans.json` and an allow/deny pair in `tests/security.entitlements.test.js`.
3. **Billing or webhook state handling:** keep the concurrency tests in `tests/security.billing.test.js` and `tests/security.webhooks.test.js` passing.
4. **New outbound HTTP:** the host must come from the environment or the code, never from a request. Add a test if any part of the URL is derived from data.
