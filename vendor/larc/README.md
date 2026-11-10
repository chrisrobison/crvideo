# vendor/larc -- LARC/PAN message bus

`pan.js` is a byte-identical copy of the published `@larcjs/core` entry
point. **Never edit it** -- upgrade by replacing the file (below). All
project code reaches it through `js/bus.js`, which imports the bare
specifier `@larcjs/core`; each page maps that specifier to this file in
its import map (`../vendor/larc/pan.js` from `scheduler/` and
`channels/`). See `docs/bus-topics.md` for how the bus is used.

| | |
| --- | --- |
| Package | `@larcjs/core` (NOT `core-lite`) |
| Version | 3.0.1 |
| Upstream repo | https://github.com/larcjs/larc |
| Fetched from | https://cdn.jsdelivr.net/npm/@larcjs/core@3.0.1/index.js |
| Date fetched | 2026-11-10 |
| sha256 | `922b0709b8f7829721f25c2820d85f113ba690cf3712a7760ce7d374e407c169` |
| Contents | `PanBus` (`<pan-bus>` element), `PanClient`, `ensureBus()`, `createClient()` -- one file, no imports |

## Updating

1. Download the new version over the old file (replace `X.Y.Z`):

   ```sh
   curl -fsSL https://cdn.jsdelivr.net/npm/@larcjs/core@X.Y.Z/index.js -o vendor/larc/pan.js
   ```

2. Verify it and record the hash:

   ```sh
   sha256sum vendor/larc/pan.js
   ```

   Compare against a second source if you can (e.g. the same file from
   `https://unpkg.com/@larcjs/core@X.Y.Z/index.js`, or the tagged file in
   the upstream repo), then update the Version / Fetched from / Date /
   sha256 rows above.

3. Read the upstream diff for changes to what `js/bus.js` relies on:
   the exports `createClient` and `PanClient`; `PanClient#publish`,
   `#subscribe(topics, handler, {retained})` (returns an unsubscribe
   function), `#request(topic, data, {timeoutMs})`, `#ready()`; the
   `pan:deliver` delivery-to-host model; `*` wildcard semantics (one dot
   segment) -- `js/bus.js` has its own copy of `matches()` for the Node
   fallback, keep it identical.

4. Retest:

   ```sh
   (cd channels && node --test tests/*.test.js)   # includes tests/bus.test.js (fallback semantics)
   php server/tests/run-tests.php
   ```

   Then in a browser (no console errors, and in devtools the request for
   `vendor/larc/pan.js` succeeds): `/scheduler/` -- switch channel, change
   date, select/drag a block; BUMPS view -- Compose/Schedule/Library load,
   selecting a bump updates preview + inspector, an edit shows the
   unsaved pill, Save works, Library "Open in Schedule" switches
   workspace; `/channels/` and `/channels/watch.html?ch=<id>` play. To
   watch traffic, run in the console:

   ```js
   const { createClient } = await import("@larcjs/core");
   createClient().subscribe("*", (m) => console.log(m.topic, m.data));
   ```
