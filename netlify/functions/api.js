import serverless from "serverless-http";
import { createApp } from "../../app.js";

let handlerPromise = null;

// Built once per warm function instance; the Express app and the Postgres pool are reused across requests.
function getHandler() {
  if (!handlerPromise) {
    handlerPromise = Promise.resolve(serverless(createApp(), { basePath: "/.netlify/functions/api" }));
  }
  return handlerPromise;
}

export const handler = async (event, context) => {
  // Let the function return while the pool keeps idle sockets open.
  context.callbackWaitsForEmptyEventLoop = false;
  const run = await getHandler();
  return run(event, context);
};
