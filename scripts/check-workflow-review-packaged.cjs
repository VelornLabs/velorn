'use strict'
// Test harness only, excluded from the app. Same synthetic IPC cases against
// the exact packaged broker, trust store and sandboxed preload.
process.env.VELORN_SPENDING_TEST_PACKAGED = '1'
require('./check-generation-spending-native.cjs')
