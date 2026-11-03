// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
    rules: {
      // Runtime callbacks inside effects execute after render; this rule reports
      // those valid callback references as declaration-order errors here.
      "react-hooks/immutability": "off",
    },
  }
]);
