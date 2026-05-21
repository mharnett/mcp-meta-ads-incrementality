# Testing this MCP

## Why this matters

This MCP talks to Meta's Marketing API. We can't (and won't) spin up live Meta servers in CI. The only reason the test suite is trustworthy is that every tool is written against an **injected interface**, not a concrete client — tests hand the tool a fake collaborator and pin exact behavior. If new tools drift back to `vi.mock(...)` of neighbor modules, the suite silently stops exercising the real wiring and we lose the safety net. Keep the DI surface honest.

## The pattern

Every tool exports three things: a `run...` function, an input schema, and a `...Deps` interface. The function takes `(input, deps)`. `deps` holds external collaborators as **interfaces**, not concrete classes.

```ts
// src/tools/insights-incrementality.ts
export interface InsightsClient {
  getInsights(params: GetInsightsParams): Promise<MetaInsightsRow[]>;
}

export interface InsightsIncrementalityDeps {
  metaClient: InsightsClient;
}

export async function runInsightsIncrementality(
  input: InsightsIncrementalityInput,
  deps: InsightsIncrementalityDeps,
) {
  const rows = await deps.metaClient.getInsights(/* ... */);
  // ...
}
```

Production wires the real client once in `src/index.ts`. Tests build a fake per test.

## What the fake looks like

Use the `FakeMetaClient` shape from `src/tools/insights-incrementality.test.ts` as the template. Explicit `lastCall` / `nextRows` / `nextError` fields make each test self-documenting about what behavior it's exercising — you can read the test and see exactly what the collaborator returned and what the SUT was asked.

```ts
interface FakeMetaClient {
  lastCall: GetInsightsParams | null;
  nextRows: MetaInsightsRow[];
  nextError: Error | null;
  getInsights(params: GetInsightsParams): Promise<MetaInsightsRow[]>;
}
```

A test then sets `fake.nextRows = [...]`, invokes the tool, and asserts on `fake.lastCall` (was the SUT's request shaped correctly?) and on the returned value (did the SUT transform the rows correctly?). No `vi.fn().mockResolvedValue(...)` chains, no module mocks.

## What NOT to do

- **Don't `vi.mock('../lib/meta-client.js', ...)`.** That bypasses the tool's declared `Deps` interface entirely and mocks the SUT's neighbors. The test no longer proves the wiring works — it proves that *if* the wiring worked, the SUT would behave correctly.
- **Don't `vi.spyOn` on internal functions.** If you find yourself wanting to control the return of a helper, that helper belongs behind a `deps` interface. Promote it.
- **Don't reach for `vi.fn()` mocks** unless you're verifying call count/args on an interface method that has no other observable effect. Prefer recording fields on the fake (like `lastCall`).

## Assertion style

Use exact pins. The Forcepoint test-quality rubric applies here:

- Yes: `toEqual(fullShape)`, `toBe(exactValue)`, `toMatchObject({ ...full expected shape })`, `rejects.toThrow(/specific-message/)`, `rejects.toBe(originalThrownValue)`.
- No: `toBeTruthy()`, `toBeDefined()`, `not.toThrow()` standing alone, `toHaveBeenCalled()` without an args matcher, `rejects.toBeTruthy()`.

A loose assertion passes for the wrong reason as often as the right one. If the test's intent really is "anything that rejects," at minimum pin to `rejects.toBeInstanceOf(Error)` and leave a comment explaining why a tighter pin doesn't apply.

## When you add a new tool

1. Define `interface XxxDeps` alongside the tool. Put every external collaborator on it as an interface.
2. Wire the real implementation in `src/index.ts` only.
3. Write the fake in the test file, not in a shared helper — keeps each test file self-contained.
4. Pin assertions exactly. If a test would pass with the SUT replaced by `() => ({})`, it isn't actually testing anything.
