// Extends eslint-config-functype with eslint-plugin-functype rules
// Full functype support: FP rules + library-specific patterns
import functypeConfig from "eslint-config-functype"
import functypePlugin from "eslint-plugin-functype"

export default {
  ...functypeConfig.configs.recommended,
  name: "ts-builds/functype",
  plugins: {
    functype: functypePlugin,
  },
  rules: {
    ...functypeConfig.configs.recommended.rules,
    // Functype library-specific rules
    "functype/prefer-option": "warn",
    "functype/prefer-either": "warn",
    "functype/prefer-fold": "warn",
    "functype/prefer-map": "warn",
    "functype/prefer-flatmap": "warn",
    "functype/no-imperative-loops": "warn",
    "functype/prefer-do-notation": "warn",
  },
}
