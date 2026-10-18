// The environment every suite runs in, set once as `testEnvironment` in
// package.json's jest config. A `@jest-environment node` pragma would bypass it,
// so no test file carries one.
//
// jest-environment-node with one change. Since Jest 30.4, resetModules (also
// run at teardown) clears mocks by reading every enumerable global, and Expo
// installs several (fetch, structuredClone, __ExpoImportMetaRegistry) as getters
// that require their implementation on first read. Read after teardown, each
// throws "You are trying to require a file outside of the scope of the test
// code". Accessors are skipped, as jest-expo's own native environment does.
//
// jest-environment-node is a devDependency of its own so that this is Jest 30's:
// @react-native/jest-preset depends on Jest 29's, which npm would otherwise
// hoist, mixing Jest 29 mocks and fake timers into the Jest 30 runtime.

const { TestEnvironment } = require("jest-environment-node");

function clearMocksOnScope(scope) {
  for (const key of Object.keys(scope)) {
    const descriptor = Object.getOwnPropertyDescriptor(scope, key);
    if (descriptor === undefined || typeof descriptor.get === "function") {
      continue;
    }
    const value = descriptor.value;
    if (
      value != null &&
      (typeof value === "object" || typeof value === "function") &&
      "_isMockFunction" in value &&
      this.isMockFunction(value) &&
      typeof value.mockClear === "function"
    ) {
      value.mockClear();
    }
  }
}

class NodeEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    // In place, not replaced: the fake timers already hold this mocker, and a
    // new one would leave their mocks out of jest.clearAllMocks().
    this.moduleMocker.clearMocksOnScope = clearMocksOnScope;
  }
}

module.exports = NodeEnvironment;
module.exports.TestEnvironment = NodeEnvironment;
