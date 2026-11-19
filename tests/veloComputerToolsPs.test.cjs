'use strict'

// Runs every Velo computer-tools test again with the macOS process tracking
// (the system ps instead of Linux's /proc). Linux has a compatible ps, so the
// Mac code path is exercised on a Linux machine too, with real bash commands.
// On a real Mac the main file already uses ps, so there is nothing to add.
if (process.platform === 'linux') {
  process.env.VELO_COMPUTER_TEST_PLATFORM = 'darwin'
  require('./veloComputerTools.test.cjs')
}
