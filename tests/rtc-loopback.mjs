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

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
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
    if (!["rtc-test.html", "rtc.js", "selftest.js"].includes(file)) return void res.writeHead(404).end();
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(dev, file)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
});

async function run(query) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${query}`);
    console.log(`--- ${query || "default output"}`);
    console.log(await page.evaluate(() => navigator.userAgent));
    await page.click("#loop");

    await page.waitForFunction(() => window.results.connected.length === 2, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 6000));
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
        const stats = results.stats.filter(s => s.name === name && s.sendFrameMs != null).slice(-3);
        assert.ok(stats.length > 0, `${name}: no stats`);
        // Captured audio per packet: 10 ms with our Opus settings, 20 ms without. Unlike
        // packets per second this does not drift when the machine is busy.
        const frame = mean(stats.map(s => s.sendFrameMs));
        assert.ok(frame > 9 && frame < 11.5, `${name}: ${frame} ms of audio per packet, expected 10`);
        for (const s of stats) assert.equal(s.packetsLost, 0);
        console.log(name, JSON.stringify(stats.at(-1)));
    }
    console.log("rtc loopback ok");

    // The plugin's own self-test (selftest.ts), as started from the settings panel.
    await page.click("#selftest");
    await page.waitForFunction(() => window.selfTest && !window.selfTest.running, { timeout: 30000 });
    const selfTest = await page.evaluate(() => window.selfTest);
    assert.equal(selfTest.error, null);
    assert.equal(selfTest.connected, true);
    assert.ok(selfTest.log.some(l => l.startsWith("send: mic opened")), "the mic was opened");
    const selfTestFrame = mean((await page.evaluate(() => window.selfTestFrames)).slice(-3));
    assert.ok(selfTestFrame > 9 && selfTestFrame < 11.5, `self-test: ${selfTestFrame} ms of audio per packet, expected 10`);
    assert.ok(selfTest.stats.jitterBufferMs > 0, "audio arrived at the receiving side");
    console.log("self-test", JSON.stringify(selfTest.stats));
    console.log("self-test ok");
    await page.close();
}

try {
    await run("");
} finally {
    await browser.close();
    server.close();
}
