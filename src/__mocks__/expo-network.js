// Jest mock for expo-network.
//
// The real module resolves a native module at import time, which throws under
// jest-expo. The surface is what services/reachability uses; tests that need
// the listener drive `emit` themselves.
const listeners = new Set();

const addNetworkStateListener = jest.fn((listener) => {
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
});

const getNetworkStateAsync = jest.fn(async () => ({
  type: "WIFI",
  isConnected: true,
  isInternetReachable: true,
}));

// Test hook, not part of expo-network.
function emit(state) {
  for (const listener of listeners) listener(state);
}

const NetworkStateType = {
  NONE: "NONE",
  UNKNOWN: "UNKNOWN",
  CELLULAR: "CELLULAR",
  WIFI: "WIFI",
  BLUETOOTH: "BLUETOOTH",
  ETHERNET: "ETHERNET",
  VPN: "VPN",
  OTHER: "OTHER",
};

module.exports = {
  NetworkStateType,
  addNetworkStateListener,
  getNetworkStateAsync,
  emit,
};
