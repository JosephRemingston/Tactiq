// HTTP API (NestJS) as a Netlify Function. Compiled by `pnpm --dir backend build` into backend/dist.
exports.handler = require('../../backend/dist/serverless/api.js').handler;
