import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Aphelion gravity laboratory", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Aphelion — N-Body Gravity Laboratory<\/title>/i);
  assert.match(html, /APHELION/);
  assert.match(html, /N-BODY NAVIGATION INSTRUMENT/);
  assert.match(html, /SUN/);
  assert.match(html, /EARTH/);
  assert.match(html, /MOON/);
  assert.match(html, /SIMULATION PARAMETERS/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships the interactive canvas and removes starter-only assets", async () => {
  const [page, lab, canvas, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GravityLab.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/UniverseCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<GravityLab \/>/);
  assert.match(lab, /simulateDuration/);
  assert.match(lab, /PRESETS/);
  assert.match(canvas, /requestAnimationFrame/);
  assert.match(canvas, /handlePointerDown/);
  assert.match(layout, /Aphelion — N-Body Gravity Laboratory/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../lib/physics.ts", import.meta.url));
});
