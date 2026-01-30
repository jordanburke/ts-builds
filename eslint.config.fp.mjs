// Re-export eslint-config-functype recommended config
// Adds functional programming rules: no-let, immutable-data, prefer-immutable-types
import functypeConfig from "eslint-config-functype"

export default functypeConfig.configs.recommended
