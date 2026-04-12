import { handleFetch } from "./router";
import type { Env } from "./types";

export type { Env };

export default {
  fetch: handleFetch,
};
