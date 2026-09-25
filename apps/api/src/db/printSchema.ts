/** Writes the Postgres schema to stdout: npm run db:schema > supabase/schema.sql */
import { PG_SCHEMA } from "./pgSchema.js";

process.stdout.write(`-- Vinted-Dashboard (Cloud) – Supabase/Postgres-Schema.\n-- Erzeugt aus apps/api/src/db/pgSchema.ts – nicht von Hand ändern.\n-- Die API legt das Schema beim Start selbst an (DB_AUTO_MIGRATE); alternativ im Supabase SQL-Editor ausführen.\n${PG_SCHEMA}`);
