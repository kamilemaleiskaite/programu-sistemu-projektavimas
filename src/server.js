const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { WebSocketServer, WebSocket } = require("ws");
const { v4: uuid } = require("uuid");

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || "teamchat-development-secret";
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const DATA_FILE = path.join(DATA_DIR, "teamchat.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const now = () => new Date().toISOString();
let state = {
  users: [],
  conversations: [],
  memberships: [],
  messages: [],
  files: [],
  workflows: [],
  notifications: [],
  refreshTokens: []
};
if (fs.existsSync(DATA_FILE)) {
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
}

const persist = () => fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
const id = (items) => items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
const clone = (value) => JSON.parse(JSON.stringify(value));
const clean = (value) => value == null ? null : value;

if (!state.users.length) {
  const password = bcrypt.hashSync("teamchat123", 10);
  state.users.push(
    { id: 1, email: "anna@teamchat.local", password_hash: password, display_name: "Anna", description: "Product Designer", location: "Vilnius", note: null, avatar_file_id: null, role: "ADMIN", status: "ONLINE", created_at: now(), deleted_at: null },
    { id: 2, email: "lukas@teamchat.local", password_hash: password, display_name: "Lukas", description: "Developer", location: "Kaunas", note: null, avatar_file_id: null, role: "USER", status: "ONLINE", created_at: now(), deleted_at: null },
    { id: 3, email: "kamile@teamchat.local", password_hash: password, display_name: "Kamilė", description: "Project Manager", location: "Vilnius", note: null, avatar_file_id: null, role: "USER", status: "AWAY", created_at: now(), deleted_at: null }
  );
  state.conversations.push(
    { id: 1, type: "CHANNEL", name: "general", description: "Team-wide announcements and conversation", is_private: false, created_by: 1, created_at: now(), last_seq: 2, dm_key: null },
    { id: 2, type: "CHANNEL", name: "product", description: "Product ideas and planning", is_private: true, created_by: 1, created_at: now(), last_seq: 1, dm_key: null }
  );
  state.memberships.push(
    { conversation_id: 1, user_id: 1, role: "OWNER", joined_at: now(), last_read_seq: 2 },
    { conversation_id: 1, user_id: 2, role: "MEMBER", joined_at: now(), last_read_seq: 1 },
    { conversation_id: 1, user_id: 3, role: "MEMBER", joined_at: now(), last_read_seq: 0 },
    { conversation_id: 2, user_id: 1, role: "OWNER", joined_at: now(), last_read_seq: 1 },
    { conversation_id: 2, user_id: 2, role: "MEMBER", joined_at: now(), last_read_seq: 0 }
  );
  state.messages.push(
    { id: 1, conversation_id: 1, sender_id: 1, client_message_id: uuid(), seq: 1, type: "TEXT", body: "Welcome to TeamChat!", attachments: [], created_at: now(), edited_at: null, deleted_at: null },
    { id: 2, conversation_id: 1, sender_id: 2, client_message_id: uuid(), seq: 2, type: "TEXT", body: "Ready to build the first sprint.", attachments: [], created_at: now(), edited_at: null, deleted_at: null },
    { id: 3, conversation_id: 2, sender_id: 1, client_message_id: uuid(), seq: 1, type: "TEXT", body: "Private product discussion starts here.", attachments: [], created_at: now(), edited_at: null, deleted_at: null }
  );
  persist();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const error = (res, status, code, message, details) => res.status(status).json({ error: code, message, ...(details ? { details } : {}) });
const findUser = (userId) => state.users.find((u) => u.id === Number(userId) && !u.deleted_at);
const membership = (conversationId, userId) => state.memberships.find((m) => m.conversation_id === Number(conversationId) && m.user_id === Number(userId));
const isMember = (conversationId, userId) => Boolean(membership(conversationId, userId));

function userSummary(user) {
  if (!user) return null;
  return { id: user.id, display_name: user.deleted_at ? "Deleted user" : user.display_name, avatar_file_id: user.deleted_at ? null : clean(user.avatar_file_id) };
}
function me(user) {
  return { ...userSummary(user), description: clean(user.description), location: clean(user.location), note: clean(user.note), email: user.email, role: user.role, created_at: user.created_at };
}
function conversationView(conversation, userId) {
  const members = state.memberships.filter((m) => m.conversation_id === conversation.id);
  const member = membership(conversation.id, userId);
  let otherUser = null;
  if (conversation.type === "DM") {
    const other = members.map((m) => findUser(m.user_id)).find((u) => u && u.id !== userId);
    otherUser = userSummary(other);
  }
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.type === "CHANNEL" ? conversation.name : null,
    description: clean(conversation.description),
    is_private: conversation.type === "CHANNEL" ? Boolean(conversation.is_private) : undefined,
    created_by: clean(conversation.created_by),
    created_at: conversation.created_at,
    last_seq: conversation.last_seq,
    member_count: members.length,
    is_member: Boolean(member),
    my_role: member ? member.role : null,
    unread_count: member ? Math.max(0, conversation.last_seq - member.last_read_seq) : 0,
    other_user: otherUser
  };
}
function messageView(message) {
  const sender = findUser(message.sender_id);
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    sender: message.type === "SYSTEM" ? null : userSummary(sender),
    client_message_id: message.client_message_id,
    seq: message.seq,
    type: message.type,
    body: clean(message.body),
    attachments: (message.attachments || []).map((fileId) => state.files.find((f) => f.id === fileId)).filter(Boolean).map(fileMeta),
    created_at: message.created_at,
    edited_at: clean(message.edited_at),
    deleted_at: clean(message.deleted_at)
  };
}
function fileMeta(file) {
  return { id: file.id, original_name: file.original_name, content_type: file.content_type, size_bytes: file.size_bytes, uploader_id: file.uploader_id, conversation_id: clean(file.conversation_id), created_at: file.created_at };
}
function workflowView(workflow) {
  return { ...workflow, creator: userSummary(findUser(workflow.creator_id)), assignee: userSummary(findUser(workflow.assignee_id)), creator_id: undefined, assignee_id: undefined };
}

const accessToken = (user) => jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: "15m" });
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return error(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = findUser(payload.sub);
    if (!req.user) throw new Error("missing user");
    next();
  } catch {
    error(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
  }
}
const tickets = new Map();

app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: now() }));
app.post("/api/v1/auth/register", async (req, res) => {
  const { email, password, display_name } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return error(res, 400, "VALIDATION_FAILED", "Some fields are invalid.", { password: "Use at least 8 characters with a letter and a digit." });
  }
  if (state.users.find((u) => u.email.toLowerCase() === email.toLowerCase() && !u.deleted_at)) return error(res, 409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
  const user = { id: id(state.users), email, password_hash: await bcrypt.hash(password, 10), display_name: display_name || email.split("@")[0], description: null, location: null, note: null, avatar_file_id: null, role: "USER", status: "ONLINE", created_at: now(), deleted_at: null };
  state.users.push(user); persist();
  res.status(201).json({ email, code_expires_in_seconds: 600 });
});
app.post("/api/v1/auth/confirm-email", async (req, res) => {
  const user = state.users.find((u) => u.email.toLowerCase() === String(req.body.email || "").toLowerCase());
  if (!user || !/^\d{6}$/.test(req.body.code || "")) return error(res, 400, "CODE_INVALID", "The confirmation code is invalid.");
  const refreshToken = crypto.randomUUID();
  state.refreshTokens.push({ token: refreshToken, user_id: user.id, replaced_by_id: null, revoked_at: null });
  persist();
  res.json({ access_token: accessToken(user), refresh_token: refreshToken, token_type: "Bearer", expires_in_seconds: 900, user: me(user) });
});
app.post("/api/v1/auth/login", async (req, res) => {
  const user = state.users.find((u) => u.email.toLowerCase() === String(req.body.email || "").toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || "", user.password_hash))) return error(res, 401, "INVALID_CREDENTIALS", "The email or password is incorrect.");
  const refreshToken = crypto.randomUUID();
  state.refreshTokens.push({ token: refreshToken, user_id: user.id, replaced_by_id: null, revoked_at: null });
  user.status = "ONLINE"; persist();
  res.json({ access_token: accessToken(user), refresh_token: refreshToken, token_type: "Bearer", expires_in_seconds: 900, user: me(user) });
});
app.post("/api/v1/auth/refresh", (req, res) => {
  const record = state.refreshTokens.find((t) => t.token === req.body.refresh_token && !t.revoked_at);
  if (!record) return error(res, 401, "UNAUTHENTICATED", "The refresh token is invalid.");
  record.revoked_at = now();
  const replacement = crypto.randomUUID();
  record.replaced_by_id = replacement;
  state.refreshTokens.push({ token: replacement, user_id: record.user_id, replaced_by_id: null, revoked_at: null });
  const user = findUser(record.user_id); persist();
  res.json({ access_token: accessToken(user), refresh_token: replacement, token_type: "Bearer", expires_in_seconds: 900, user: me(user) });
});
app.post("/api/v1/auth/logout", auth, (req, res) => {
  state.refreshTokens.filter((t) => t.user_id === req.user.id).forEach((t) => t.revoked_at = now());
  req.user.status = "OFFLINE"; persist(); res.status(204).end();
});
app.post("/api/v1/auth/ws-ticket", auth, (req, res) => {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId: req.user.id, expiresAt: Date.now() + 30000 });
  res.json({ ticket, expires_in_seconds: 30 });
});

app.get("/api/v1/users/me", auth, (req, res) => res.json(me(req.user)));
app.patch("/api/v1/users/me", auth, (req, res) => {
  ["display_name", "description", "location", "note"].forEach((key) => { if (Object.prototype.hasOwnProperty.call(req.body, key)) req.user[key] = req.body[key]; });
  persist(); res.json(me(req.user));
});
app.get("/api/v1/users", auth, (req, res) => {
  const query = String(req.query.query || "").toLowerCase();
  const items = state.users.filter((u) => !u.deleted_at && (!query || u.display_name.toLowerCase().includes(query))).map((u) => ({ ...userSummary(u), description: clean(u.description), location: clean(u.location), note: clean(u.note), last_seen_at: u.status === "OFFLINE" ? now() : null }));
  res.json({ items });
});
app.put("/api/v1/users/me/status", auth, (req, res) => {
  if (!["ONLINE", "AWAY", "OFFLINE"].includes(req.body.status)) return error(res, 400, "VALIDATION_FAILED", "Invalid presence status.");
  req.user.status = req.body.status; persist(); res.status(204).end();
});
app.get("/api/v1/presence", auth, (_req, res) => res.json({ items: state.users.filter((u) => !u.deleted_at).map((u) => ({ user_id: u.id, status: u.status, last_seen_at: u.status === "OFFLINE" ? now() : null })) }));

app.get("/api/v1/conversations", auth, (req, res) => {
  const ids = state.memberships.filter((m) => m.user_id === req.user.id).map((m) => m.conversation_id);
  let items = state.conversations.filter((c) => ids.includes(c.id));
  if (req.query.type) items = items.filter((c) => c.type === req.query.type);
  const query = String(req.query.query || "").toLowerCase();
  if (query) items = items.filter((c) => c.type === "CHANNEL" ? c.name.toLowerCase().includes(query) : conversationView(c, req.user.id).other_user?.display_name.toLowerCase().includes(query));
  items.sort((a, b) => b.last_seq - a.last_seq);
  res.json({ items: items.map((c) => conversationView(c, req.user.id)) });
});
app.get("/api/v1/channels", auth, (req, res) => {
  const query = String(req.query.query || "").toLowerCase();
  const items = state.conversations.filter((c) => c.type === "CHANNEL" && (!c.is_private || isMember(c.id, req.user.id)) && (!query || c.name.toLowerCase().includes(query))).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ items: items.map((c) => conversationView(c, req.user.id)) });
});
app.post("/api/v1/channels", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name.length < 3 || name.length > 50) return error(res, 400, "VALIDATION_FAILED", "Channel name must be 3 to 50 characters.", { name: "Use 3 to 50 characters." });
  if (state.conversations.some((c) => c.type === "CHANNEL" && c.name.toLowerCase() === name.toLowerCase())) return error(res, 409, "CHANNEL_NAME_TAKEN", "A channel with this name already exists.");
  const conversation = { id: id(state.conversations), type: "CHANNEL", name, description: req.body.description || null, is_private: Boolean(req.body.is_private), created_by: req.user.id, created_at: now(), last_seq: 0, dm_key: null };
  state.conversations.push(conversation);
  state.memberships.push({ conversation_id: conversation.id, user_id: req.user.id, role: "OWNER", joined_at: now(), last_read_seq: 0 });
  persist(); res.status(201).json(conversationView(conversation, req.user.id));
});
app.get("/api/v1/conversations/:conversation_id", auth, (req, res) => {
  const conversation = state.conversations.find((c) => c.id === Number(req.params.conversation_id));
  if (!conversation || (conversation.type === "DM" && !isMember(conversation.id, req.user.id)) || (conversation.is_private && !isMember(conversation.id, req.user.id))) return error(res, 404, "NOT_FOUND", "Conversation not found.");
  res.json(conversationView(conversation, req.user.id));
});
app.post("/api/v1/channels/:conversation_id/join", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id) && x.type === "CHANNEL");
  if (!c || c.is_private) return error(res, 404, "NOT_FOUND", "Channel not found.");
  if (!isMember(c.id, req.user.id)) state.memberships.push({ conversation_id: c.id, user_id: req.user.id, role: "MEMBER", joined_at: now(), last_read_seq: 0 });
  persist(); res.status(204).end();
});
app.post("/api/v1/channels/:conversation_id/leave", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id) && x.type === "CHANNEL");
  const m = membership(c?.id, req.user.id);
  if (!c || !m) return error(res, 404, "NOT_FOUND", "Channel not found.");
  if (m.role === "OWNER" && state.memberships.some((x) => x.conversation_id === c.id && x.user_id !== req.user.id)) return error(res, 409, "OWNER_CANNOT_LEAVE", "The owner cannot leave while other members remain.");
  state.memberships = state.memberships.filter((x) => !(x.conversation_id === c.id && x.user_id === req.user.id)); persist(); res.status(204).end();
});
app.post("/api/v1/dms", auth, (req, res) => {
  const otherId = Number(req.body.user_id);
  const other = findUser(otherId);
  if (!other || other.id === req.user.id) return error(res, 400, "VALIDATION_FAILED", "Cannot open a DM with this user.");
  const dmKey = [req.user.id, other.id].sort((a, b) => a - b).join(":");
  let conversation = state.conversations.find((c) => c.type === "DM" && c.dm_key === dmKey);
  const existed = Boolean(conversation);
  if (!conversation) {
    conversation = { id: id(state.conversations), type: "DM", name: null, description: null, is_private: true, created_by: req.user.id, created_at: now(), last_seq: 0, dm_key: dmKey };
    state.conversations.push(conversation);
    state.memberships.push({ conversation_id: conversation.id, user_id: req.user.id, role: "MEMBER", joined_at: now(), last_read_seq: 0 });
    state.memberships.push({ conversation_id: conversation.id, user_id: other.id, role: "MEMBER", joined_at: now(), last_read_seq: 0 });
  }
  persist(); res.status(existed ? 200 : 201).json(conversationView(conversation, req.user.id));
});
app.get("/api/v1/conversations/:conversation_id/members", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id));
  if (!c) return error(res, 404, "NOT_FOUND", "Conversation not found.");
  if (!isMember(c.id, req.user.id)) return c.is_private ? error(res, 404, "NOT_FOUND", "Conversation not found.") : error(res, 403, "NOT_A_MEMBER", "Join the channel to view its members.");
  res.json({ items: state.memberships.filter((m) => m.conversation_id === c.id).sort((a, b) => a.joined_at.localeCompare(b.joined_at)).map((m) => ({ user: userSummary(findUser(m.user_id)), role: m.role, joined_at: m.joined_at })) });
});
app.post("/api/v1/channels/:conversation_id/members", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id) && x.type === "CHANNEL");
  const user = findUser(req.body.user_id);
  if (!c || !user) return error(res, 404, "NOT_FOUND", "Channel or user not found.");
  if (!isMember(c.id, req.user.id)) return error(res, 403, "NOT_A_MEMBER", "You are not a member of this channel.");
  if (!membership(c.id, user.id)) state.memberships.push({ conversation_id: c.id, user_id: user.id, role: "MEMBER", joined_at: now(), last_read_seq: 0 });
  persist(); res.status(204).end();
});

app.get("/api/v1/conversations/:conversation_id/messages", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id));
  if (!c) return error(res, 404, "NOT_FOUND", "Conversation not found.");
  if (!isMember(c.id, req.user.id)) return c.is_private ? error(res, 404, "NOT_FOUND", "Conversation not found.") : error(res, 403, "NOT_A_MEMBER", "Join the channel to view messages.");
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  let messages = state.messages.filter((m) => m.conversation_id === c.id);
  if (req.query.before_seq) messages = messages.filter((m) => m.seq < Number(req.query.before_seq)).sort((a, b) => b.seq - a.seq).slice(0, limit);
  else if (req.query.after_seq) messages = messages.filter((m) => m.seq > Number(req.query.after_seq)).sort((a, b) => a.seq - b.seq).slice(0, limit);
  else messages = messages.sort((a, b) => b.seq - a.seq).slice(0, limit);
  res.json({ items: messages.map(messageView), has_more: messages.length === limit });
});
app.post("/api/v1/conversations/:conversation_id/messages", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id));
  if (!c) return error(res, 404, "NOT_FOUND", "Conversation not found.");
  if (!isMember(c.id, req.user.id)) return error(res, 403, "NOT_A_MEMBER", "You are not a member of this conversation.");
  const existing = state.messages.find((m) => m.conversation_id === c.id && m.client_message_id === req.body.client_message_id);
  if (existing) return res.status(200).json(messageView(existing));
  if (!req.body.body && !(req.body.attachment_ids || []).length) return error(res, 400, "VALIDATION_FAILED", "A message needs text or an attachment.");
  if (String(req.body.body || "").length > 4000) return error(res, 400, "VALIDATION_FAILED", "Message text is too long.");
  c.last_seq += 1;
  const message = { id: id(state.messages), conversation_id: c.id, sender_id: req.user.id, client_message_id: req.body.client_message_id || uuid(), seq: c.last_seq, type: "TEXT", body: req.body.body || null, attachments: (req.body.attachment_ids || []).slice(0, 10), created_at: now(), edited_at: null, deleted_at: null };
  state.messages.push(message); persist();
  broadcast({ type: "message.created", ts: now(), payload: { message: messageView(message) } });
  res.status(201).json(messageView(message));
});
app.put("/api/v1/conversations/:conversation_id/read", auth, (req, res) => {
  const m = membership(req.params.conversation_id, req.user.id);
  if (!m) return error(res, 403, "NOT_A_MEMBER", "You are not a member of this conversation.");
  m.last_read_seq = Math.max(m.last_read_seq, Number(req.body.last_read_seq) || 0); persist(); res.status(204).end();
});
app.patch("/api/v1/messages/:message_id", auth, (req, res) => {
  const m = state.messages.find((x) => x.id === Number(req.params.message_id));
  if (!m) return error(res, 404, "NOT_FOUND", "Message not found.");
  if (m.sender_id !== req.user.id && req.user.role !== "ADMIN") return error(res, 403, "FORBIDDEN", "Only the author or an administrator can edit this message.");
  if (m.deleted_at) return error(res, 409, "MESSAGE_DELETED", "A deleted message cannot be edited.");
  m.body = req.body.body; m.edited_at = now(); persist();
  broadcast({ type: "message.updated", ts: now(), payload: { message: messageView(m) } });
  res.json(messageView(m));
});
app.delete("/api/v1/messages/:message_id", auth, (req, res) => {
  const m = state.messages.find((x) => x.id === Number(req.params.message_id));
  if (!m) return error(res, 404, "NOT_FOUND", "Message not found.");
  if (m.sender_id !== req.user.id && req.user.role !== "ADMIN") return error(res, 403, "FORBIDDEN", "Only the author or an administrator can delete this message.");
  if (!m.deleted_at) { m.deleted_at = now(); persist(); broadcast({ type: "message.deleted", ts: now(), payload: { conversation_id: m.conversation_id, message_id: m.id, deleted_at: m.deleted_at } }); }
  res.status(204).end();
});

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });
app.post("/api/v1/files", auth, upload.single("file"), (req, res) => {
  if (!req.file) return error(res, 400, "VALIDATION_FAILED", "A file is required.");
  const file = { id: id(state.files), original_name: req.file.originalname, content_type: req.file.mimetype, size_bytes: req.file.size, uploader_id: req.user.id, conversation_id: req.body.conversation_id ? Number(req.body.conversation_id) : null, created_at: now(), stored_name: req.file.filename };
  state.files.push(file); persist(); res.status(201).json(fileMeta(file));
});
app.get("/api/v1/files", auth, (req, res) => {
  const allowed = state.memberships.filter((m) => m.user_id === req.user.id).map((m) => m.conversation_id);
  let items = state.files.filter((f) => f.uploader_id === req.user.id || (f.conversation_id && allowed.includes(f.conversation_id)));
  res.json({ items: items.map(fileMeta) });
});
app.get("/api/v1/files/:file_id/download", auth, (req, res) => {
  const file = state.files.find((f) => f.id === Number(req.params.file_id));
  if (!file) return error(res, 404, "NOT_FOUND", "File not found.");
  const canAccess = file.uploader_id === req.user.id || (file.conversation_id && isMember(file.conversation_id, req.user.id));
  if (!canAccess) return error(res, 403, "FORBIDDEN", "You cannot access this file.");
  res.setHeader("Content-Disposition", `attachment; filename="${file.original_name.replace(/["\\]/g, "_")}"`);
  res.sendFile(path.join(UPLOAD_DIR, file.stored_name));
});

app.post("/api/v1/conversations/:conversation_id/workflows", auth, (req, res) => {
  const c = state.conversations.find((x) => x.id === Number(req.params.conversation_id));
  if (!c || !isMember(c.id, req.user.id)) return error(res, 403, "NOT_A_MEMBER", "You are not a member of this channel.");
  const workflow = { id: id(state.workflows), conversation_id: c.id, creator_id: req.user.id, assignee_id: req.body.assignee_id || null, title: req.body.title, category: req.body.category || null, description: req.body.description, importance: req.body.importance, status: "OPEN", created_at: now(), updated_at: now(), completed_at: null };
  state.workflows.push(workflow); persist(); res.status(201).json(workflowView(workflow));
});
app.get("/api/v1/workflows", auth, (req, res) => {
  const items = state.workflows.filter((w) => isMember(w.conversation_id, req.user.id) && (!req.query.assigned_to_me || w.assignee_id === req.user.id));
  res.json({ items: items.map(workflowView) });
});
app.get("/api/v1/workflows/:workflow_id", auth, (req, res) => {
  const workflow = state.workflows.find((w) => w.id === Number(req.params.workflow_id));
  if (!workflow || !isMember(workflow.conversation_id, req.user.id)) return error(res, 404, "NOT_FOUND", "Workflow not found.");
  res.json(workflowView(workflow));
});
app.post("/api/v1/workflows/:workflow_id/assign", auth, (req, res) => {
  const w = state.workflows.find((x) => x.id === Number(req.params.workflow_id));
  if (!w || !isMember(w.conversation_id, req.user.id)) return error(res, 404, "NOT_FOUND", "Workflow not found.");
  w.assignee_id = req.body.user_id; w.updated_at = now(); persist(); res.status(204).end();
});
app.post("/api/v1/workflows/:workflow_id/start", auth, (req, res) => {
  const w = state.workflows.find((x) => x.id === Number(req.params.workflow_id));
  if (!w) return error(res, 404, "NOT_FOUND", "Workflow not found.");
  if (w.assignee_id !== req.user.id) return error(res, 403, "NOT_ASSIGNEE", "Only the assignee can start this workflow.");
  w.status = "IN_PROGRESS"; w.updated_at = now(); persist(); res.json(workflowView(w));
});
app.post("/api/v1/workflows/:workflow_id/complete", auth, (req, res) => {
  const w = state.workflows.find((x) => x.id === Number(req.params.workflow_id));
  if (!w) return error(res, 404, "NOT_FOUND", "Workflow not found.");
  if (w.assignee_id !== req.user.id) return error(res, 403, "NOT_ASSIGNEE", "Only the assignee can complete this workflow.");
  w.status = "COMPLETED"; w.completed_at = now(); w.updated_at = w.completed_at; persist(); res.json(workflowView(w));
});

app.get("/api/v1/notifications", auth, (req, res) => {
  const items = state.notifications.filter((n) => n.user_id === req.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ items: items.map(({ user_id, ...n }) => n) });
});
app.post("/api/v1/notifications/read-all", auth, (req, res) => {
  state.notifications.filter((n) => n.user_id === req.user.id).forEach((n) => n.read_at ||= now()); persist(); res.status(204).end();
});
app.post("/api/v1/notifications/:notification_id/read", auth, (req, res) => {
  const n = state.notifications.find((x) => x.id === Number(req.params.notification_id) && x.user_id === req.user.id);
  if (!n) return error(res, 404, "NOT_FOUND", "Notification not found.");
  n.read_at = now(); persist(); res.status(204).end();
});
app.get("/api/v1/search/messages", auth, (req, res) => {
  const query = String(req.query.query || "").toLowerCase();
  const allowed = state.memberships.filter((m) => m.user_id === req.user.id).map((m) => m.conversation_id);
  const items = state.messages.filter((m) => allowed.includes(m.conversation_id) && (!query || String(m.body || "").toLowerCase().includes(query))).slice(-50).reverse();
  res.json({ items: items.map((m) => { const c = state.conversations.find((x) => x.id === m.conversation_id); return { message: messageView(m), conversation_id: c.id, conversation_name: c.type === "CHANNEL" ? c.name : conversationView(c, req.user.id).other_user?.display_name }; }) });
});

app.use((req, res) => error(res, 404, "NOT_FOUND", "Endpoint not found."));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  const ticket = url.searchParams.get("ticket");
  const record = tickets.get(ticket);
  if (!record || record.expiresAt < Date.now()) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  tickets.delete(ticket);
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, record.userId));
});
function broadcast(event) {
  wss.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); });
}
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "presence.heartbeat") ws.send(JSON.stringify({ type: "presence.changed", ts: now(), payload: { user_id: frame.payload?.user_id, status: frame.payload?.idle ? "AWAY" : "ONLINE" } }));
      else if (frame.type === "typing") ws.send(JSON.stringify({ type: "typing", ts: now(), payload: { conversation_id: frame.payload.conversation_id, user_id: frame.payload.user_id } }));
      else ws.send(JSON.stringify({ type: "ws.error", ts: now(), payload: { code: "VALIDATION_FAILED", message: "Unknown WebSocket event." } }));
    } catch {
      ws.send(JSON.stringify({ type: "ws.error", ts: now(), payload: { code: "VALIDATION_FAILED", message: "Malformed JSON frame." } }));
    }
  });
});

server.listen(PORT, () => console.log(`TeamChat listening on http://localhost:${PORT}`));
