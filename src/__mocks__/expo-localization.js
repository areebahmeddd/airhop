// Jest mock for expo-localization.
//
// The real module reads a native module at import time. English on a US phone
// is the device every other suite assumes; tests of the resolution itself call
// `languageForTags` directly.
const getLocales = jest.fn(() => [
  { languageTag: "en-US", languageCode: "en", regionCode: "US" },
]);

module.exports = { getLocales };
