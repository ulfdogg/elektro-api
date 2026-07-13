var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var CORS_HEADERS = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin };
}
__name(corsHeaders, "corsHeaders");
function json(data, status = 200, request = null) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (request) Object.assign(headers, corsHeaders(request));
  return new Response(JSON.stringify(data), { status, headers });
}
__name(json, "json");
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  if (!stored.startsWith("pbkdf2:")) return false;
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const computed = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === hashHex;
}
__name(verifyPassword, "verifyPassword");
function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)es_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}
__name(getSessionToken, "getSessionToken");
function sessionCookieHeader(token, expires) {
  if (!token) return `es_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return `es_session=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires * 1e3).toUTCString()}`;
}
__name(sessionCookieHeader, "sessionCookieHeader");
async function getCurrentUser(request, db) {
  const token = getSessionToken(request);
  if (!token) return null;
  const row = await db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.is_demo
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, Math.floor(Date.now() / 1e3)).first();
  return row || null;
}
__name(getCurrentUser, "getCurrentUser");
async function handleLogin(request, db) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = body.password || "";
  const row = await db.prepare("SELECT id, password_hash FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
  if (!row || !await verifyPassword(password, row.password_hash))
    return json({ error: "Benutzername oder Passwort falsch" }, 401, request);
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Math.floor(Date.now() / 1e3)).run();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const exp = Math.floor(Date.now() / 1e3) + 60 * 60 * 24 * 30;
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, row.id, exp).run();
  const headers = { ...corsHeaders(request), "Set-Cookie": sessionCookieHeader(token, exp), "Content-Type": "application/json" };
  return new Response(JSON.stringify({ user: { id: row.id, username } }), { status: 200, headers });
}
__name(handleLogin, "handleLogin");
async function handleLogout(request, db) {
  const token = getSessionToken(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  const headers = { ...corsHeaders(request), "Set-Cookie": sessionCookieHeader(null, 0), "Content-Type": "application/json" };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(handleLogout, "handleLogout");
async function handleMe(request, db) {
  const user = await getCurrentUser(request, db);
  return json(user ? { user: { id: user.id, username: user.username, is_admin: !!user.is_admin, is_demo: !!user.is_demo } } : { user: null }, 200, request);
}
__name(handleMe, "handleMe");
async function handleRegister(request, db) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = body.password || "";
  const turnstileToken = body.turnstileToken || "";
  if (turnstileToken) {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: "0x4AAAAAADwVa02SvZRQHmoT_ZJYKREtaEY", response: turnstileToken })
    });
    const result = await res.json();
    if (!result.success) return json({ error: "Bot-Verifizierung fehlgeschlagen. Bitte versuche es erneut." }, 400, request);
  }
  if (username.length < 3 || username.length > 32)
    return json({ error: "Benutzername muss 3\u201332 Zeichen lang sein" }, 400, request);
  if (!/^[a-zA-Z0-9_\-]+$/.test(username))
    return json({ error: "Nur Buchstaben, Ziffern, _ und - erlaubt" }, 400, request);
  if (password.length < 6)
    return json({ error: "Passwort muss mindestens 6 Zeichen lang sein" }, 400, request);
  const existing = await db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
  if (existing) return json({ error: "Benutzername bereits vergeben" }, 409, request);
  const hash = await hashPassword(password);
  const ins = await db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, hash).run();
  const userId = ins.meta.last_row_id;
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const exp = Math.floor(Date.now() / 1e3) + 60 * 60 * 24 * 30;
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, exp).run();
  const headers = { ...corsHeaders(request), "Set-Cookie": sessionCookieHeader(token, exp), "Content-Type": "application/json" };
  return new Response(JSON.stringify({ user: { id: userId, username } }), { status: 200, headers });
}
__name(handleRegister, "handleRegister");
async function handleCircuits(request, db) {
  const user = await getCurrentUser(request, db);
  if (!user) return json({ error: "Nicht angemeldet" }, 401, request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const method = request.method;
  if (method === "GET" && id) {
    const row = await db.prepare("SELECT id, name, type, data, updated_at FROM circuits WHERE id = ? AND user_id = ?").bind(parseInt(id), user.id).first();
    if (!row) return json({ error: "Nicht gefunden" }, 404, request);
    row.data = JSON.parse(row.data);
    return json(row, 200, request);
  }
  if (method === "GET") {
    const type = url.searchParams.get("type");
    let rows;
    if (type) {
      const result = await db.prepare("SELECT id, name, type, updated_at FROM circuits WHERE user_id = ? AND type = ? ORDER BY updated_at DESC").bind(user.id, type).all();
      rows = result.results;
    } else {
      const result = await db.prepare("SELECT id, name, type, updated_at FROM circuits WHERE user_id = ? ORDER BY updated_at DESC").bind(user.id).all();
      rows = result.results;
    }
    return json(rows, 200, request);
  }
  if (method === "POST") {
    if (user.is_demo) return json({ error: "Demo-Konto kann nicht speichern" }, 403, request);
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    const type = body.type || "schematic";
    const data = body.data ?? null;
    if (!name) return json({ error: "Name fehlt" }, 400, request);
    if (!["schematic", "fbd"].includes(type)) return json({ error: "Ung\xFCltiger Typ" }, 400, request);
    if (data === null) return json({ error: "Daten fehlen" }, 400, request);
    const dataJson = typeof data === "string" ? data : JSON.stringify(data);
    const now = Math.floor(Date.now() / 1e3);
    if (id) {
      const result = await db.prepare("UPDATE circuits SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(name, dataJson, now, parseInt(id), user.id).run();
      if (result.meta.changes === 0) return json({ error: "Nicht gefunden oder kein Zugriff" }, 404, request);
      return json({ id: parseInt(id), name }, 200, request);
    } else {
      const result = await db.prepare("INSERT INTO circuits (user_id, name, type, data, updated_at) VALUES (?, ?, ?, ?, ?)").bind(user.id, name, type, dataJson, now).run();
      return json({ id: result.meta.last_row_id, name }, 201, request);
    }
  }
  if (method === "DELETE") {
    if (user.is_demo) return json({ error: "Demo-Konto kann nicht l\xF6schen" }, 403, request);
    if (!id) return json({ error: "ID fehlt" }, 400, request);
    const result = await db.prepare("DELETE FROM circuits WHERE id = ? AND user_id = ?").bind(parseInt(id), user.id).run();
    if (result.meta.changes === 0) return json({ error: "Nicht gefunden" }, 404, request);
    return json({ ok: true }, 200, request);
  }
  return json({ error: "Method not allowed" }, 405, request);
}
__name(handleCircuits, "handleCircuits");
async function handleAdmin(request, db) {
  const user = await getCurrentUser(request, db);
  if (!user) return json({ error: "Nicht angemeldet" }, 401, request);
  if (!user.is_admin) return json({ error: "Admin-Rechte erforderlich" }, 403, request);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";
  const method = request.method;
  if (action === "users") {
    const result = await db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.created_at, COUNT(c.id) as project_count
      FROM users u LEFT JOIN circuits c ON c.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `).all();
    return json({ users: result.results }, 200, request);
  }
  if (action === "delete_user") {
    if (method !== "DELETE") return json({ error: "Method not allowed" }, 405, request);
    const targetId = parseInt(url.searchParams.get("id") || "0");
    if (!targetId) return json({ error: "Keine Benutzer-ID angegeben" }, 400, request);
    if (targetId === user.id) return json({ error: "Du kannst dich nicht selbst l\xF6schen" }, 400, request);
    await db.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();
    return json({ success: true }, 200, request);
  }
  if (action === "all_projects") {
    const result = await db.prepare(`
      SELECT c.id, c.name, c.type, c.updated_at, c.user_id, u.username
      FROM circuits c JOIN users u ON u.id = c.user_id ORDER BY c.updated_at DESC
    `).all();
    return json({ projects: result.results }, 200, request);
  }
  if (action === "load_project") {
    const projectId = parseInt(url.searchParams.get("id") || "0");
    if (!projectId) return json({ error: "Keine Projekt-ID angegeben" }, 400, request);
    const row = await db.prepare("SELECT c.*, u.username FROM circuits c JOIN users u ON u.id = c.user_id WHERE c.id = ?").bind(projectId).first();
    if (!row) return json({ error: "Projekt nicht gefunden" }, 404, request);
    return json(row, 200, request);
  }
  if (action === "promote") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405, request);
    const targetId = parseInt(url.searchParams.get("id") || "0");
    if (!targetId) return json({ error: "Keine Benutzer-ID angegeben" }, 400, request);
    await db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(targetId).run();
    return json({ success: true }, 200, request);
  }
  if (action === "demote") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405, request);
    const targetId = parseInt(url.searchParams.get("id") || "0");
    if (!targetId) return json({ error: "Keine Benutzer-ID angegeben" }, 400, request);
    if (targetId === user.id) return json({ error: "Du kannst dir nicht selbst Admin-Rechte entziehen" }, 400, request);
    await db.prepare("UPDATE users SET is_admin = 0 WHERE id = ?").bind(targetId).run();
    return json({ success: true }, 200, request);
  }
  return json({ error: "Ung\xFCltige Aktion" }, 400, request);
}
__name(handleAdmin, "handleAdmin");
async function handleChangePassword(request, db) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  const user = await getCurrentUser(request, db);
  if (!user) return json({ error: "Nicht angemeldet" }, 401, request);
  if (user.is_demo) return json({ error: "Demo-Konto kann Passwort nicht \xE4ndern" }, 403, request);
  const body = await request.json().catch(() => ({}));
  const currentPassword = body.current_password || "";
  const newPassword = body.new_password || "";
  if (newPassword.length < 6)
    return json({ error: "Neues Passwort muss mindestens 6 Zeichen lang sein" }, 400, request);
  const row = await db.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
  if (!row || !await verifyPassword(currentPassword, row.password_hash))
    return json({ error: "Aktuelles Passwort ist falsch" }, 401, request);
  const hash = await hashPassword(newPassword);
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, user.id).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, getSessionToken(request)).run();
  return json({ ok: true }, 200, request);
}
__name(handleChangePassword, "handleChangePassword");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (path === "/api/login.php") return handleLogin(request, env.DB);
    if (path === "/api/logout.php") return handleLogout(request, env.DB);
    if (path === "/api/me.php") return handleMe(request, env.DB);
    if (path === "/api/register.php") return handleRegister(request, env.DB);
    if (path === "/api/circuits.php") return handleCircuits(request, env.DB);
    if (path === "/api/admin.php") return handleAdmin(request, env.DB);
    if (path === "/api/change_password.php") return handleChangePassword(request, env.DB);
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
