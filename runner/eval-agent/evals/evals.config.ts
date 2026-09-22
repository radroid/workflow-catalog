import { defineEvalConfig } from "eve/evals";

// Deterministic evals only: the fixture's model is scripted and no eval uses
// t.judge, so no judge or provider is ever called.
export default defineEvalConfig({});
