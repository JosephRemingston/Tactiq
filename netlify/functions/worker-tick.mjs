// Scheduled function (schedule in netlify.toml): wakes the background worker so delayed and retried jobs run
// even when nobody calls the API.
export default async () => {
  const base = process.env.URL;
  if (!base) return new Response('URL not set', { status: 500 });
  const secret = process.env.WORKER_TRIGGER_SECRET;
  const res = await fetch(`${base}/.netlify/functions/worker-background`, {
    method: 'POST',
    headers: secret ? { 'x-worker-secret': secret } : {},
  });
  return new Response(`worker-background: ${res.status}`);
};
