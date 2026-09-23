module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  env: {
    browser: true,
    commonjs: true,
    es6: true,
  },
  ignorePatterns: [
    "!**/.server",
    "!**/.client",
    "extensions/**/shopify.d.ts",
    "extensions/*/generated/**",
  ],

  extends: ["eslint:recommended"],

  overrides: [
    {
      files: ["**/*.{ts,tsx}"],
      parser: "@typescript-eslint/parser",
      rules: {
        // TypeScript itself resolves types and unused bindings; the core rules
        // only see erased syntax and report every type reference as undefined.
        "no-undef": "off",
        "no-unused-vars": "off",
      },
    },

    {
      files: [
        ".eslintrc.cjs",
        "vite.config.{js,ts}",
        ".graphqlrc.{js,ts}",
        "shopify.server.{js,ts}",
        "**/*.server.{js,ts}",
      ],
      env: {
        node: true,
      },
    },
  ],
  globals: {
    shopify: "readonly",
  },
};
