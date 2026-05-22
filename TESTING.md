# Testing this MCP

## Why this matters

This MCP talks to Meta's Marketing API. We can't (and won't) spin up live Meta servers in CI, so every test substitutes a fake at some boundary. The thing we care about is that the test still exercises the SUT's real logic — its request shape, its error handling, its safety checks — and only fakes the network. A test that mocks the function under test (or its neighbors so completely that the SUT is bypassed) gives false confidence.

## Two patterns in use today

The codebase currently uses two different fake-injection styles. Both are acceptable. Don't rewrite working tests to switch patterns.

### Pattern A — dependency injection (preferred for new tools)

The tool exports a `...Deps` interface. The function takes `(input, deps)`. Tests construct a fake collaborator and hand it in. Production wires the real client once in `src/index.ts`.

Used by: `insights-incrementality.ts`.

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
) { /* ... */ }
```

Test side (template — copy from `insights-incrementality.test.ts`):

```ts
interface FakeMetaClient {
  lastCall: GetInsightsParams | null;
  nextRows: MetaInsightsRow[];
  nextError: Error | null;
  getInsights(params: GetInsightsParams): Promise<MetaInsightsRow[]>;
}
```

Why prefer this for new tools: the boundary the tool depends on is named in its own type signature, fakes compose without touching global state, and failure-injection (`nextError`) is a per-test field rather than a chain of mock setups. Most importantly, the SUT's contract with its collaborator becomes the *only* thing the test can observe — there's no way to accidentally test transport plumbing instead of behavior.

### Pattern B — `vi.stubGlobal('fetch', ...)`

The tool calls Graph directly via the shared `graphGet` / `graphPost` helpers in `src/lib/graph.ts`. Tests stub the global `fetch` and assert on the captured URL/body.

Used by: `lifecycle.ts`, `audiences-and-forms.ts`, `campaign-build.ts`, `url-tags.ts`.

```ts
function setupFetchMock(responses: Array<unknown | { _status: number; _body: unknown }>) {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: /* ... */ });
    /* return next response */
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());
```

This is acceptable when the tool is a thin orchestrator over Graph calls and the interesting behavior IS the request shape (verb, path, form fields). For most of these tools — small REST writers, single-call reads — Pattern B keeps the test honest because it exercises everything from input parsing through URL construction.

It stops being acceptable when the tool needs to inject failures at a *domain* boundary, not the transport (e.g., "what if the rate limiter says back off, what if the SDK returns a partial page"). At that point the fetch-level fake becomes a tangle of branching response arrays and it's time to extract a `Deps` interface.

## What's actually a problem (vs. what isn't)

- `vi.mock('../tools/url-tags.js', ...)` — bad. Mocking the SUT or a sibling tool means the test stops exercising the real code path.
- `vi.spyOn` on an internal helper inside the same module — bad if you're using it to control return values. If a helper needs to be controllable per-test, promote it onto a `Deps` interface.
- `vi.stubGlobal('fetch', ...)` — fine. `fetch` is the transport boundary; faking it is faking the network, not faking the SUT.
- `vi.fn().mockResolvedValue(...)` on a `Deps` method — fine, but prefer explicit fake fields (`fake.nextRows = [...]`, `expect(fake.lastCall).toEqual(...)`) for readability.

The shorthand: **fake the network or the named collaborator; never fake the function you're testing or its same-module neighbors.**

## Migration path

When refactoring an existing tool — or when a Pattern B test file starts collecting branching `if (url.includes(...))` logic that's hard to follow — move that tool to Pattern A. Steps:

1. Extract the Graph calls behind an interface (`interface XxxClient { ... }`) that names the operations the tool needs, not the HTTP verbs.
2. Add a `XxxDeps` to the tool and accept it as the second arg.
3. Wire the real implementation in `src/index.ts`.
4. Rewrite that file's tests against the fake. Leave other tools alone.

Don't do mass migrations. The cost of converting a working `vi.stubGlobal` test is real and the benefit is marginal for small tools.

## Assertion style (applies to both patterns)

Use exact pins. Pattern-matching against partial output is how bugs hide.

- Yes: `toEqual(fullShape)`, `toBe(exactValue)`, `toMatchObject({ ...full expected shape })`, `rejects.toThrow(/specific-message/)`, `rejects.toBe(originalThrownValue)`.
- No: `toBeTruthy()`, `toBeDefined()`, `not.toThrow()` standing alone, `toHaveBeenCalled()` without an args matcher, `rejects.toBeTruthy()`.

A loose assertion passes for the wrong reason as often as the right one. If the test's intent really is "anything that rejects," at minimum pin to `rejects.toBeInstanceOf(Error)` and leave a comment explaining why a tighter pin doesn't apply.

## When you add a new tool

1. Default to Pattern A. Define `interface XxxDeps` alongside the tool.
2. If the tool is genuinely a one-call REST writer with nothing interesting to mock besides the transport, Pattern B is acceptable.
3. Pin assertions exactly. If a test would pass with the SUT replaced by `() => ({})`, it isn't actually testing anything.
