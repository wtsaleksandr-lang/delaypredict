import { defineConfig } from "drizzle-kit";

// DATABASE_URL is only required if you've switched storage to PostgresStorage
// and want to run `npm run db:push`. The default JsonFileStorage doesn't need it.
const url = process.env.DATABASE_URL || "postgres://placeholder";

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
});
