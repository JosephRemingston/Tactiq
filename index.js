import { getEnv } from "./configs/env.js";
import connectDB from "./configs/database.js";
import { connectRedis } from "./configs/redis.js";
import { createApp } from "./app.js";

const env = getEnv();

await connectDB();
console.log("Postgres connected");

const redis = await connectRedis();
console.log(redis ? "Redis connected" : "Redis unavailable: continuing without cache and rate limits");

var app = createApp();

app.listen(env.PORT, () => {
  console.log(`server listening on http://localhost:${env.PORT}`);
});
