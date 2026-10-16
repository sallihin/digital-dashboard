// Digital Dashboard server
// Zero dependencies: Node.js 18+ only. Serves the dashboard behind a password
// and stores data in a JSON file on disk.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/* ---------- config (.env) ---------- */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, ".env"));

const PASSWORD = process.env.DASHBOARD_PASSWORD;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_FILE = path.resolve(__dirname, process.env.DATA_FILE || "data/db.json");
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SECURE_COOKIE = process.env.SECURE_COOKIE === "true";
// Sessions are signed with a key derived from the password, so changing the
// password in .env signs everyone out automatically.
const SECRET = crypto.createHash("sha256").update("digital-dashboard:" + (process.env.SESSION_SECRET || "") + ":" + (PASSWORD || "")).digest();

if (!PASSWORD) {
  console.error("DASHBOARD_PASSWORD is not set. Copy .env.example to .env and set a password.");
  process.exit(1);
}

const PUBLIC = path.join(__dirname, "public");
const COLLS = new Set(["people", "projects", "todos", "allocs", "holidays"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

/* ---------- data store ---------- */
function emptyState() { return { people: {}, projects: {}, todos: {}, allocs: {}, holidays: {} }; }
let state = emptyState();
try {
  if (fs.existsSync(DATA_FILE)) state = { ...emptyState(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
} catch (e) {
  console.error("Could not read " + DATA_FILE + ": " + e.message);
  process.exit(1);
}
let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(e => console.error("Save failed:", e.message));
  return writing;
}

/* ---------- sessions ---------- */
function sign(v) { return crypto.createHmac("sha256", SECRET).update(v).digest("base64url"); }
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = exp + "." + crypto.randomBytes(12).toString("base64url");
  return body + "." + sign(body);
}
function validToken(t) {
  if (!t) return false;
  const i = t.lastIndexOf(".");
  if (i < 0) return false;
  const body = t.slice(0, i), sig = t.slice(i + 1);
  const good = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return false;
  return Number(body.split(".")[0]) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(value, maxAge) {
  return `dd_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (SECURE_COOKIE ? "; Secure" : "");
}
function passwordOk(input) {
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- login throttling ---------- */
const attempts = new Map(); // ip -> {count, until}
function clientIp(req) {
  if (process.env.TRUST_PROXY === "true" && req.headers["x-forwarded-for"]) return req.headers["x-forwarded-for"].split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
function locked(ip) { const a = attempts.get(ip); return a && a.until > Date.now(); }
function failed(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 8) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0; }
  attempts.set(ip, a);
}

/* ---------- helpers ---------- */
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};
function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type || "text/plain; charset=utf-8", ...extra });
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj), "application/json; charset=utf-8"); }
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function loginPage(error) {
  const html = fs.readFileSync(path.join(PUBLIC, "login.html"), "utf8");
  return html.replace("<!--ERROR-->", error ? `<p class="err" role="alert">${error}</p>` : "");
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const authed = validToken(cookies(req).dd_session);

    if (p === "/login" && req.method === "GET") {
      if (authed) return send(res, 302, "", undefined, { Location: "/" });
      return send(res, 200, loginPage(), "text/html; charset=utf-8");
    }
    if (p === "/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (locked(ip)) return send(res, 429, loginPage("Too many attempts. Try again in 15 minutes."), "text/html; charset=utf-8");
      const form = new URLSearchParams(await readBody(req, 4096));
      if (passwordOk(form.get("password") || "")) {
        attempts.delete(ip);
        return send(res, 302, "", undefined, { Location: "/", "Set-Cookie": sessionCookie(makeToken(), SESSION_DAYS * 86400) });
      }
      failed(ip);
      await new Promise(r => setTimeout(r, 600));
      return send(res, 401, loginPage("That password isn't right."), "text/html; charset=utf-8");
    }
    if (p === "/logout") {
      return send(res, 302, "", undefined, { Location: "/login", "Set-Cookie": sessionCookie("", 0) });
    }

    if (!authed) {
      if (p.startsWith("/api/")) return json(res, 401, { error: "signed_out" });
      return send(res, 302, "", undefined, { Location: "/login" });
    }

    if (p === "/" || p === "/index.html") {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, "index.html")), "text/html; charset=utf-8");
    }

    if (p === "/api/state" && req.method === "GET") return json(res, 200, state);

    const m = p.match(/^\/api\/([a-z]+)\/([^/]+)$/);
    if (m && COLLS.has(m[1]) && ID_RE.test(decodeURIComponent(m[2]))) {
      const coll = m[1], id = decodeURIComponent(m[2]);
      if (req.method === "PUT") {
        let doc;
        try { doc = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad_json" }); }
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) return json(res, 400, { error: "bad_body" });
        state[coll][id] = doc;
        await persist();
        return send(res, 204, "");
      }
      if (req.method === "DELETE") {
        delete state[coll][id];
        await persist();
        return send(res, 204, "");
      }
    }
    return send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Server error");
  }
});

server.listen(PORT, HOST, () => console.log(`Digital Dashboard running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
