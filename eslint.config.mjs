import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Code written by Prisma (never edited by hand).
    "src/generated/**",
    // One-off Milestone 2 migration helper (plain Node script, not part of the app).
    "scripts/m2-ops/**",
    // One-off timestamp correction tool (plain Node script, not part of the app).
    "scripts/tz-ops/**",
    // Release and scheduled-job helpers for the real database (plain Node / PowerShell, not part of the app).
    "scripts/ops/**",
  ]),
  {
    // Tests and database check scripts talk to raw database drivers where "any" is common.
    // Application code under src/ keeps the strict rule.
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);

export default eslintConfig;
