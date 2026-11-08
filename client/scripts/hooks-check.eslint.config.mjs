// CI check: React hooks must run on every render (a hook after an early return crashes the
// app with "Minified React error #300/#310"). Run by .github/workflows/build.yml.
import hooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": hooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
