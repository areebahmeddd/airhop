// Runs a HyperFrames command at the pinned version, with the local tools on
// PATH: `node scripts/hyperframes.mjs snapshot --at 31,104.5`.

import { hyperframes } from "./tools.mjs";

hyperframes(process.argv.slice(2), { stdio: "inherit" });
