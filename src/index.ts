// Library entry point. The upper layer (src/kit) is added here once the workflows are validated.
export * as data from "./generated/data.js";
export type * as types from "./generated/types.js";
export { tools as toolManifest, serverVersion } from "./generated/manifest.js";
export { callTool, getCallCount, close } from "./lib/client.js";
export * as kit from "./kit/index.js";
