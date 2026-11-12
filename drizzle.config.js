import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./models/index.js",
  out: "./migrations",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://touchline:touchline@localhost:5432/touchline" },
  strict: true,
});
