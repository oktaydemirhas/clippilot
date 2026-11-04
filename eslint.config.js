import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "data", "public", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts: the TypeScript rules above know these globals from the types, plain JS does not.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", setTimeout: "readonly", fetch: "readonly", FormData: "readonly", Blob: "readonly" },
    },
  },
);
