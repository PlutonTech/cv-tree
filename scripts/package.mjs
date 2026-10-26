// npm run package: build, check the release is ready for the Chrome Web Store, and zip it into dist/.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const config = JSON.parse(readFileSync(join(root, "cvtree.config.json"), "utf8"));

// Things that make a public release worse, flagged before you upload.
const warnings = [];
if (!config.serverUrl) warnings.push("No serverUrl in cvtree.config.json: no free AI (everyone needs their own key), no usage stats, no privacy policy page.");
else if (!/^https:\/\//.test(config.serverUrl)) warnings.push(`serverUrl should be https:// for a public release (it's ${config.serverUrl}).`);
if (!config.githubClientId) warnings.push("No githubClientId: people will have to register their own GitHub app to connect GitHub.");
if (!config.contactEmail && !config.publisherName) warnings.push("No publisherName / contactEmail in cvtree.config.json (also set PUBLISHER_NAME and CONTACT_EMAIL on the server for the privacy policy).");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) warnings.push(`Version "${manifest.version}" should look like 1.2.3.`);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (!/\.map$|\.DS_Store$|Thumbs\.db$/.test(name)) files.push(p);
  }
})(join(root, "extension"));

mkdirSync(join(root, "dist"), { recursive: true });
// --friends: a zip to share directly (people load it with "Load unpacked"), with install steps inside.
const friends = process.argv.includes("--friends");
const out = join(root, "dist", `cv-tree-${manifest.version}${friends ? "-friends" : ""}.zip`);
const entries = files.map(p => ({ name: relative(join(root, "extension"), p).replace(/\\/g, "/"), data: readFileSync(p) }));
if (friends) entries.unshift({ name: "HOW-TO-INSTALL.txt", data: readFileSync(join(root, "scripts/HOW-TO-INSTALL.txt")) });
writeFileSync(out, zip(entries));

const kb = n => (n / 1024).toFixed(0) + " KB";
console.log(`\nPackaged ${entries.length} files -> ${relative(root, out)} (${kb(statSync(out).size)})`);
console.log(`Version ${manifest.version}. Bump "version" in extension/manifest.json before uploading an update.`);
if (warnings.length) console.log("\nBefore publishing:\n" + warnings.map(w => "  - " + w).join("\n"));
else console.log(friends ? "Ready to share: send the zip; HOW-TO-INSTALL.txt inside explains the rest." : "Ready to upload at https://chrome.google.com/webstore/devconsole");

/* ---------- a minimal zip writer (deflate), enough for the Web Store ---------- */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = (() => { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8"), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime.time, 10); local.writeUInt16LE(dosTime.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime.time, 12); central.writeUInt16LE(dosTime.date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
