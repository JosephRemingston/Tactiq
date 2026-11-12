// Imported first by unit tests that load app modules without a database: a harmless, fully local environment.
// NODE_ENV=test also stops configs/env.js from reading any .env file (which may hold production credentials).
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unit:unit@127.0.0.1:1/unit",
  REDIS_URL: "",
  STORAGE_DRIVER: "fs",
  CLERK_JWT_KEY: "",
  CLERK_SECRET_KEY: "",
  CLERK_AUTHORIZED_PARTIES: "",
  CLERK_WEBHOOK_SIGNING_SECRET: "",
  GOOGLE_PLAY_PACKAGE_NAME: "",
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "",
  GOOGLE_PLAY_RTDN_TOKEN: "",
  BILLING_FAKE_VERIFIER: "false",
  EDGE_SHARED_SECRET: "",
  CORS_ORIGINS: "",
});
