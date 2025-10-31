import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";

const reactHooksRules = reactHooks.configs["recommended-latest"].rules;
const reactRefreshPlugin = reactRefresh.configs.vite.plugins["react-refresh"];
const reactRefreshRules = reactRefresh.configs.vite.rules;

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefreshPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooksRules,
      ...reactRefreshRules,
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]" }],
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
    },
  },
]);
