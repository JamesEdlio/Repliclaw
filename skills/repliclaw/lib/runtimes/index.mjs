// Runtime registry. Exposes loadRuntime(id) which returns an adapter object
// implementing the interface documented in runtimes/README.md.

import kernRuntime from "./kern.mjs";
import openclawRuntime from "./openclaw.mjs";

const RUNTIMES = {
  kern: kernRuntime,
  openclaw: openclawRuntime,
};

export const SUPPORTED_RUNTIMES = Object.keys(RUNTIMES);

export function loadRuntime(id) {
  const rt = RUNTIMES[id];
  if (!rt) {
    throw new Error(
      `unknown runtime: ${id}. Supported: ${SUPPORTED_RUNTIMES.join(", ")}`
    );
  }
  return rt;
}
