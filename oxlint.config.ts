import { defineConfig } from "oxlint"

export default defineConfig({
  env: {
    browser: true,
    builtin: true,
    node: true,
  },
  ignorePatterns: ["plugins/*/scripts"],
  jsPlugins: ["eslint-plugin-unused-imports", "eslint-plugin-perfectionist"],
  options: { typeAware: true },
  plugins: ["eslint", "typescript", "unicorn", "import"],
  rules: {
    "perfectionist/sort-exports": [
      "error",
      { partitionByNewLine: true, type: "natural" },
    ],
    "perfectionist/sort-imports": [
      "error",
      {
        groups: [
          "type-import",
          ["type-parent", "type-sibling", "type-index"],
          "type-internal",
          ["value-builtin", "value-external"],
          "value-internal",
          ["value-parent", "value-sibling", "value-index"],
          "ts-equals-import",
          "unknown",
        ],
        newlinesBetween: "ignore",
        newlinesInside: "ignore",
        partitionByNewLine: true,
        type: "natural",
      },
    ],
    "typescript/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "unused-imports/no-unused-imports": "error",

    "perfectionist/sort-array-includes": ["warn", { type: "natural" }],
    "perfectionist/sort-interfaces": [
      "warn",
      { partitionByNewLine: true, type: "natural" },
    ],
    "perfectionist/sort-intersection-types": ["warn", { type: "natural" }],
    "perfectionist/sort-jsx-props": ["warn", { type: "natural" }],
    "perfectionist/sort-maps": ["warn", { type: "natural" }],
    "perfectionist/sort-named-exports": ["warn", { type: "natural" }],
    "perfectionist/sort-named-imports": ["warn", { type: "natural" }],
    "perfectionist/sort-object-types": [
      "warn",
      { partitionByNewLine: true, type: "natural" },
    ],
    "perfectionist/sort-objects": [
      "warn",
      { partitionByNewLine: true, type: "natural" },
    ],
    "perfectionist/sort-sets": ["warn", { type: "natural" }],
    "perfectionist/sort-union-types": ["warn", { type: "natural" }],
  },
})
