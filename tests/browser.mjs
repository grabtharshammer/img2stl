// Headless browser smoke test: load the page, build stamps from the example SVG and from a PNG,
// with and without the cookie cutter, and download the STL.
//   cd tests && npm install && node browser.mjs [chromium path] [screenshot dir]
// Set BASE_URL to test a deployed copy instead of serving ../web locally.
import http from "node:http";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "../web");
const chrome = process.argv[2] ?? "/usr/bin/chromium";
const shots = process.argv[3] ?? ".";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = process.env.BASE_URL ?? `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
let failed = false;
const fail = (msg) => { failed = true; console.log("FAIL", msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a PNG with lettering, to exercise the bitmap path (and light-on-dark with the "light parts" switch)
const pngPath = join(await mkdtemp(join(tmpdir(), "img2stl-png-")), "hello.png");
{
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 240 });
  await page.setContent(`<body style="margin:0;background:#fff"><div style="font:bold 120px sans-serif;padding:40px 30px">Hi&nbsp;★</div></body>`);
  await page.screenshot({ path: pngPath });
  await page.close();
}

async function run(name, { width, height, dark }) {
  const ctx = await browser.createBrowserContext();   // fresh localStorage per run
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  page.on("console", (m) => m.type() === "error" && fail(`${name} console: ${m.text()}`));
  page.on("pageerror", (e) => fail(`${name} page error: ${e.message}`));
  const dl = await mkdtemp(join(tmpdir(), "img2stl-"));
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl, browserContextId: ctx.id });

  await page.goto(url, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(shots, `${name}-empty.png`) });
  const click = async (sel) => {
    await page.$eval(sel, (b) => b.scrollIntoView({ block: "center" }));
    await page.click(sel);
  };
  // the model rebuilds by itself; wait until it's current (or an error shows)
  const settle = async (what) => {
    const t0 = Date.now();
    await sleep(400);
    await page.waitForFunction(() => document.getElementById("status").textContent === "Model is up to date." ||
                                     !document.getElementById("error").hidden, { timeout: 120000 });
    const err = await page.$eval("#error", (e) => (e.hidden ? null : e.textContent));
    if (err) throw new Error(`${name} build error (${what}): ${err}`);
    const stats = await page.$eval("#stats", (e) => e.innerText.replace(/\n/g, " "));
    const notes = await page.$eval("#notes", (e) => (e.hidden ? "" : ` · notes: ${e.innerText.replace(/\n/g, " ")}`));
    console.log(`${name}: ${what} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stats}${notes}`);
    await sleep(600);
    return stats;
  };
  const setSlider = (key, v) => page.$eval(`#r-${key}`, (r, v) => { r.value = v; r.dispatchEvent(new Event("input")); }, v);

  await click("#example");
  let stats = await settle("leaf");
  if (!/\d+ × 60 × 4\.5 mm/.test(stats)) fail(`${name}: leaf stamp should be 60 mm long and 4.5 mm tall: ${stats}`);
  await page.screenshot({ path: join(shots, `${name}-leaf.png`) });
  if (width <= 860) {
    // phones: the viewer stays pinned to the bottom of the screen while the settings scroll
    for (const y of [0, 500, 1000]) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await sleep(200);
      const r = await page.$eval("#viewer", (v) => { const b = v.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight }; });
      if (Math.abs(r.bottom - r.vh) > 1 || r.top < r.vh * 0.4) fail(`${name}: viewer not pinned at scroll ${y}: ${JSON.stringify(r)}`);
    }
    await page.screenshot({ path: join(shots, `${name}-sticky.png`) });
  }

  await click("#cutter-on");
  stats = await settle("leaf + cutter");
  if (!/× 9\.0 mm/.test(stats)) fail(`${name}: cutter should make it 3 + 6 = 9 mm tall: ${stats}`);
  await page.screenshot({ path: join(shots, `${name}-cutter.png`) });

  await click('#raise [data-v="background"]');
  await click('#shape [data-v="circle"]');
  await settle("background raised, circle, cutter");
  await page.screenshot({ path: join(shots, `${name}-circle.png`) });

  await click("#download");
  for (let i = 0; i < 40 && !(await readdir(dl)).some((f) => f.endsWith(".stl")); i++) await sleep(250);
  const files = await readdir(dl);
  const stl = files.find((f) => f.endsWith(".stl"));
  if (!stl) fail(`${name}: no STL downloaded (${files})`);
  else {
    const buf = await readFile(join(dl, stl)), n = buf.readUInt32LE(80);
    if (buf.length !== 84 + 50 * n || n < 1000) fail(`${name}: bad STL ${stl}: ${n} triangles, ${buf.length} bytes`);
    else console.log(`${name}: downloaded ${stl}, ${n} triangles`);
  }

  // a bitmap with text; turn the cutter off and use a rectangle
  await click("#cutter-on");
  await click('#shape [data-v="rect"]');
  await click('#raise [data-v="design"]');
  const input = await page.$("#file");
  await input.uploadFile(pngPath);
  stats = await settle("PNG text, rect");
  await setSlider("size", 90);
  stats = await settle("PNG text, 90 mm");
  if (!/90 × \d+ × 4\.5 mm/.test(stats)) fail(`${name}: should be 90 mm wide: ${stats}`);
  await page.screenshot({ path: join(shots, `${name}-png.png`) });

  // light parts: the white background becomes the design, the lettering the gaps in it
  await click('#ink [data-v="light"]');
  stats = await settle("PNG light parts");
  if (!/90 × \d+ × 4\.5 mm/.test(stats)) fail(`${name}: light parts should still be 90 mm wide: ${stats}`);
  // a margin too big for the size: a clear message, no crash
  await setSlider("size", 20);
  await setSlider("margin", 12);
  await page.waitForFunction(() => !document.getElementById("error").hidden, { timeout: 5000 }).catch(() => {});
  const err = await page.$eval("#error", (e) => (e.hidden ? null : e.textContent));
  if (!err) fail(`${name}: expected a "no room" error`);
  else console.log(`${name}: no-room message: ${err}`);

  // reset: every setting back to its default, the image stays
  await click("#reset");
  stats = await settle("after reset");
  if (!/60 × \d+ × 4\.5 mm/.test(stats)) fail(`${name}: reset should give the 60 mm default: ${stats}`);
  const back = await page.evaluate(() => [document.getElementById("r-size").value, document.getElementById("r-margin").value,
    document.querySelector('#ink [aria-checked="true"]')?.dataset.v, document.querySelector('#shape [aria-checked="true"]')?.dataset.v]);
  if (back.join() !== "60,3,dark,outline") fail(`${name}: controls after reset: ${back}`);
  await ctx.close();
}

try {
  await run("desktop", { width: 1400, height: 900 });
  await run("mobile-dark", { width: 390, height: 844, dark: true });
} catch (e) { fail(e.message); }
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
