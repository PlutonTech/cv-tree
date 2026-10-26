// Bundles src/ into extension/ (the folder you load in chrome://extensions) and draws the toolbar icons.
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const watch = process.argv.includes("--watch");

// Build-time settings: cvtree.config.json, with CVTREE_SERVER_URL / CVTREE_GITHUB_CLIENT_ID overriding it.
const config = JSON.parse(readFileSync("cvtree.config.json", "utf8"));
if (process.env.CVTREE_SERVER_URL) config.serverUrl = process.env.CVTREE_SERVER_URL;
if (process.env.CVTREE_GITHUB_CLIENT_ID) config.githubClientId = process.env.CVTREE_GITHUB_CLIENT_ID;
const built = {
  serverUrl: String(config.serverUrl || "").replace(/\/$/, ""), analytics: config.analytics !== false, hostedAI: config.hostedAI !== false,
  ingestKey: config.ingestKey || "cvtree-ingest", githubClientId: config.githubClientId || "",
};
const on = (flag, what) => console.log(`${flag ? "on " : "off"}  ${what}`);
on(built.serverUrl && built.analytics, `usage stats${built.serverUrl ? " -> " + built.serverUrl : " (no serverUrl in cvtree.config.json)"}`);
on(built.serverUrl && built.hostedAI, "free hosted AI");
on(built.githubClientId, "one-click GitHub sign-in");
const options = {
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
  },
  outdir: "extension",
  bundle: true,
  loader: { ".css": "text" },             // the widget inlines templates.css into its shadow DOM
  define: { __CVTREE__: JSON.stringify(built) },
  format: "iife",
  target: "chrome120",
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

// The full app is an ES module: pdf.js needs it. jsPDF's optional HTML renderer is never used, so it stays out.
// pdfgen is the PDF builder the widget imports only when you download or attach a CV.
const appOptions = { ...options, entryPoints: { app: "src/app.js", pdfgen: "src/pdfgen.js" }, format: "esm", external: ["html2canvas", "dompurify", "canvg"] };

writeIcons();
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "extension/pdf.worker.min.mjs");
if (watch) {
  for (const o of [options, appOptions]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(appOptions)]);
}

/* ---------- icons: green tile with a white sheet and three lines, encoded as PNG by hand ---------- */
function writeIcons() {
  mkdirSync("extension/icons", { recursive: true });
  for (const size of [16, 32, 48, 128]) writeFileSync(`extension/icons/icon${size}.png`, png(size));
}
function png(n) {
  const px = Buffer.alloc(n * (n * 4 + 1));
  const teal = [14, 122, 85], white = [255, 255, 255], mark = [243, 211, 92];
  const r = n * 0.22;
  for (let y = 0; y < n; y++) {
    px[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n, v = (y + 0.5) / n;
      let c = null, a = 255;
      // rounded tile
      const dx = Math.max(r - (x + 0.5), 0, (x + 0.5) - (n - r)), dy = Math.max(r - (y + 0.5), 0, (y + 0.5) - (n - r));
      if (dx * dx + dy * dy <= r * r) c = teal; else a = 0;
      // sheet
      if (c && u > 0.27 && u < 0.73 && v > 0.2 && v < 0.8) c = white;
      // text lines + highlighted line
      if (c === white && u > 0.35 && u < 0.65) {
        if (v > 0.32 && v < 0.38) c = mark;
        else if ((v > 0.46 && v < 0.51) || (v > 0.59 && v < 0.64)) c = teal;
      }
      const i = y * (n * 4 + 1) + 1 + x * 4;
      const [R, G, B] = c || [0, 0, 0];
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return crc ^ 0xffffffff;
}
