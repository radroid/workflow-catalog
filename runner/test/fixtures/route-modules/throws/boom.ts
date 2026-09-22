// Fixture: a route module that throws while it loads. The launcher must fail
// before it spawns eve, so nothing is left running.
export {};

throw new Error("fixture route module failed to load");
