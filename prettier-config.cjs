/**
 * Shareable Prettier configuration for TypeScript library templates
 *
 * Uses CommonJS format for compatibility with prettier's shareable config feature.
 * When using "prettier": "ts-builds/prettier" in package.json, prettier uses
 * require() internally which doesn't handle ESM default exports properly.
 *
 * @see https://prettier.io/docs/sharing-configurations
 * @see https://github.com/prettier/prettier/issues/15388 - ESM support tracking
 */
module.exports = {
  semi: false,
  trailingComma: "all",
  singleQuote: false,
  printWidth: 120,
  tabWidth: 2,
  endOfLine: "auto",
}
