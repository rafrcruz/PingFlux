module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ["eslint:recommended", "prettier"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  ignorePatterns: ["node_modules/", "coverage/", "data/"],
  overrides: [
    {
      files: ["src/web/public/**/*.js"],
      env: { browser: true },
      globals: {
        echarts: "readonly",
      },
    },
  ],
  rules: {
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  },
};
