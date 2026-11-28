const app = document.getElementById("app");
let token = localStorage.getItem("teamchat_access");
let me = null;
let conversations = [];
let activeConversation = null;
let messages = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function renderAuth() {
  app.innerHTML = `
    <section class="auth"><div class="auth-card">
      <div class="brand"><div class="brand-mark">T</div><strong>TeamChat</strong></div>
      <h1>Sign in to your workspace</h1>
      <p>Use the demo account or enter your account details.</p>
      <form class="form" id="login-form">
        <input name="email" type="email" value="anna@teamchat.local" required>
        <input name="password" type="password" value="teamchat123" required>
        <div class="error" id="auth-error"></div>
        <button type="submit">Sign in</button>
      </form>
    </div></section>`;
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventEvent?.();
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
      token = result.access_token;
      localStorage.setItem("teamchat_access", token);
      me = result.user;
      await startApp();
    } catch (error) { document.getElementById("auth-error").textContent = error.message; }
  });
}

async function startApp() {
  me ||= await api("/api/v1/users/me");
  await loadConversations();
  if (!activeConversation && conversations.length) activeConversation = conversations[0];
  renderShell();
  if (activeConversation) await openConversation(activeConversation.id);
}

async function loadConversations() {
  const page = await api("/api/v1/conversations");
  conversations = page.items;
}

function renderShell() {
  app.innerHTML = `
    <section class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">T</div><span>TeamChat</span></div>
        <nav class="nav">
          <button class="active"><span>Messages</span></button>
          <button id="channels-nav"><span>Channels</span></button>
          <button><span>Workflows</span></button>
        </nav>
      </aside>
      <aside class="conversation-list">
        <h2>Messages</h2>
        <div id="conversation-items"></div>
      </aside>
      <section class="chat">
        <header class="chat-header" id="chat-header"></header>
        <div class="messages" id="messages"></div>
        <form class="composer" id="composer"><input id="message-input" autocomplete="off" placeholder="Write a message..."><button type="submit">➤</button></form>
      </section>
      <aside class="details"><h2>Members</h2><div id="member-list"></div></aside>
    </section>`;
  renderConversationList();
  document.getElementById("composer").addEventListener("submit", sendMessage);
}

function renderConversationList() {
  const container = document.getElementById("conversation-items");
  container.innerHTML = conversations.map((conversation) => `
    <button class="channel-button ${activeConversation?.id === conversation.id ? "active" : ""}" data-id="${conversation.id}">
      <span>${conversation.type === "CHANNEL" ? "#" : ""}${escapeHtml(conversation.name || conversation.other_user?.display_name || "DM")}</span>
      ${conversation.unread_count ? `<span class="badge">${conversation.unread_count}</span>` : ""}
    </button>`).join("");
  container.querySelectorAll("[data-id]").forEach((button) => button.addEventListener("click", () => openConversation(Number(button.dataset.id))));
}

async function openConversation(id) {
  activeConversation = conversations.find((c) => c.id === id);
  const page = await api(`/api/v1/conversations/${id}/messages`);
  messages = page.items.reverse();
  renderConversationList();
  document.getElementById("chat-header").innerHTML = `<div><h2>${activeConversation.type === "CHANNEL" ? "#" : ""}${escapeHtml(activeConversation.name || activeConversation.other_user?.display_name)}</h2><p>${escapeHtml(activeConversation.description || "Direct message")}</p></div>`;
  renderMessages();
  const members = await api(`/api/v1/conversations/${id}/members`);
  document.getElementById("member-list").innerHTML = members.items.map((member) => `
    <div class="member"><div class="avatar">${escapeHtml(member.user.display_name.slice(0, 2).toUpperCase())}</div><span>${escapeHtml(member.user.display_name)}</span><span class="status-dot"></span></div>`).join("");
  await api(`/api/v1/conversations/${id}/read`, { method: "PUT", body: JSON.stringify({ last_read_seq: activeConversation.last_seq }) });
}

function renderMessages() {
  const container = document.getElementById("messages");
  container.innerHTML = messages.map((message) => `
    <article class="message">
      <div class="avatar">${escapeHtml((message.sender?.display_name || "S").slice(0, 2).toUpperCase())}</div>
      <div><strong>${escapeHtml(message.sender?.display_name || "System")}</strong><time>${new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      <p>${escapeHtml(message.deleted_at ? "message deleted" : message.body || "")}</p></div>
    </article>`).join("");
  container.scrollTop = container.scrollHeight;
}

async function sendMessage(event) {
  event.preventDefault();
  const input = document.getElementById("message-input");
  const body = input.value.trim();
  if (!body || !activeConversation) return;
  try {
    const message = await api(`/api/v1/conversations/${activeConversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ client_message_id: crypto.randomUUID(), body })
    });
    messages.push(message);
    input.value = "";
    renderMessages();
  } catch (error) { alert(error.message); }
}

if (token) startApp().catch(() => { token = null; localStorage.removeItem("teamchat_access"); renderAuth(); });
else renderAuth();
