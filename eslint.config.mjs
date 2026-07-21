import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  { rules: { "react-hooks/set-state-in-effect": "off", "react-hooks/purity": "off", "import/no-anonymous-default-export": "off" } },
  globalIgnores([".next/**", "node_modules/**", "coverage/**", "tsconfig.tsbuildinfo"]),
]);
