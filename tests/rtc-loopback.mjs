// Runs rtc.ts in a real (headless) Chromium: two sessions in one page, wired
// together, with Chromium's fake microphone. Proves that the sessions connect,
// that the Opus munging is accepted and that 10 ms frames are really sent.
//
// Needs dev/rtc.js (npm run test:rtc builds it) and a Chrome/Chromium binary:
// set CHROME, otherwise common locations are tried.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const dev = join(dirname(fileURLToPath(import.meta.url)), "..", "dev");
const chrome = [
    process.env.CHROME,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(p => p && existsSync(p));
assert.ok(chrome, "No Chrome found. Set the CHROME environment variable.");

const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const file = path === "/" ? "rtc-test.html" : path.slice(1);
    if (!["rtc-test.html", "rtc.js"].includes(file)) return void res.writeHead(404).end();
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(dev, file)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
});

try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    console.log(await page.evaluate(() => navigator.userAgent));
    await page.click("#loop");

    await page.waitForFunction(() => window.results.connected.length === 2, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    const results = await page.evaluate(() => window.results);
    const log = await page.evaluate(() => document.getElementById("log").textContent);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(results.failed, []);

    for (const type of ["offer", "answer"]) {
        const sdp = results.sdp[type];
        assert.match(sdp, /a=fmtp:\d+ .*useinbandfec=0/, `${type}: FEC off`);
        assert.match(sdp, /a=fmtp:\d+ .*usedtx=0/, `${type}: DTX off`);
        assert.match(sdp, /a=ptime:10/, `${type}: ptime`);
        assert.match(sdp, /a=maxptime:10/, `${type}: maxptime`);
    }

    assert.match(log, /jitterBufferTarget set to 0 ms/);

    for (const name of ["a", "b"]) {
        const stats = results.stats.filter(s => s.name === name && s.sendPacketsPerSec != null).slice(-3);
        assert.ok(stats.length > 0, `${name}: no stats`);
        for (const s of stats) {
            // 10 ms frames are 100 packets per second. 20 ms frames would be 50.
            assert.ok(s.sendPacketsPerSec > 85 && s.sendPacketsPerSec < 115, `${name}: ${s.sendPacketsPerSec} packets/s, expected about 100`);
            assert.equal(s.packetsLost, 0);
        }
        console.log(name, JSON.stringify(stats.at(-1)));
    }
    console.log("rtc loopback ok");
} finally {
    await browser.close();
    server.close();
}
