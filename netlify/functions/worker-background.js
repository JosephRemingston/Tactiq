// BullMQ workers as a Netlify Background Function (runs up to 15 minutes, returns 202 immediately).
// Woken by the API after jobs are enqueued and by the scheduled worker-tick function.
exports.handler = require('../../backend/dist/serverless/worker.js').handler;
