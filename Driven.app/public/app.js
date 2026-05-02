const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  me: null,
  socket: null,
  servers: [],
  currentServer: null,
  channels: [],
  currentChannel: null,
  members: [],
  online: new Set(),
  typingTimeout: null,
  typingUsers: new Set(),
  pendingInvite: null,
  view: 'server', // 'server' | 'home'
  friendsTab: 'all',
  friends: { accepted: [], incoming: [], outgoing: [] },
  dms: [],
  currentDM: null,
};

// Detect ?invite=CODE on load (from /invite/:code redirect)
const urlParams = new URLSearchParams(location.search);
if (urlParams.get('invite')) {
  state.pendingInvite = urlParams.get('invite');
  fetch(`/api/invites/${state.pendingInvite}`).then(r => r.json()).then(data => {
    if (data.error) return;
    const banner = $('#invite-banner');
    banner.classList.remove('hidden');
    banner.innerHTML = `You've been invited to join <b>${escapeHtml(data.name)}</b>. Sign in or sign up to accept.`;
  });
}

// ---------- AUTH UI ----------
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$$('a[data-switch]').forEach(a => a.addEventListener('click', () => switchTab(a.dataset.switch)));

function switchTab(tab) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#login-form').classList.toggle('hidden', tab !== 'login');
  $('#register-form').classList.toggle('hidden', tab !== 'register');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const err = $('#login-error'); err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    await bootApp();
  } catch (ex) { err.textContent = ex.message; }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const err = $('#register-error'); err.textContent = '';
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fd.get('email'),
        username: fd.get('username'),
        password: fd.get('password'),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    await bootApp();
  } catch (ex) { err.textContent = ex.message; }
});

$('#logout-btn').addEventListener('click', logout);
$('#empty-logout').addEventListener('click', logout);

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  if (state.socket) state.socket.disconnect();
  state.me = null; state.servers = []; state.currentServer = null;
  $('#app').classList.add('hidden');
  $('#empty-state').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

// ---------- BOOT ----------
async function tryAutoLogin() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) await bootApp();
  } catch {}
}

async function bootApp() {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) return;
  state.me = await meRes.json();

  $('#auth').classList.add('hidden');

  // If pending invite, redeem first
  if (state.pendingInvite) {
    try {
      const r = await fetch(`/api/invites/${state.pendingInvite}/accept`, { method: 'POST' });
      if (r.ok) {
        const { server } = await r.json();
        history.replaceState(null, '', '/');
        state.pendingInvite = null;
        await loadServers(server.id);
        return;
      }
    } catch {}
    state.pendingInvite = null;
    history.replaceState(null, '', '/');
  }

  await loadServers();
}

async function loadServers(selectId = null) {
  const servers = await fetch('/api/servers').then(r => r.json());
  state.servers = servers;
  renderServerRail();

  $('#empty-state').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // user UI
  $('#me-username').textContent = state.me.username;
  const av = $('#me-avatar');
  av.style.background = state.me.avatar_color;
  av.textContent = state.me.username[0].toUpperCase();

  if (!state.socket) connectSocket();

  if (selectId && servers.find(s => s.id === selectId)) {
    await selectServer(servers.find(s => s.id === selectId));
  } else if (servers.length) {
    await selectServer(servers[0]);
  } else {
    await openHome();
  }
}

function renderServerRail() {
  const rail = $('#servers-rail');
  rail.querySelectorAll('.server-icon[data-server-id]').forEach(n => n.remove());
  const bottomDivider = $('#rail-bottom-divider');
  for (const s of state.servers) {
    const el = document.createElement('div');
    el.className = 'server-icon' + (state.view === 'server' && state.currentServer?.id === s.id ? ' active' : '');
    el.dataset.serverId = s.id;
    el.style.background = s.icon_color || '#5865f2';
    el.textContent = s.name.slice(0, 2).toUpperCase();
    el.title = s.name;
    el.addEventListener('click', () => selectServer(s));
    rail.insertBefore(el, bottomDivider);
  }
  $('#home-btn').classList.toggle('active', state.view === 'home');
}

async function selectServer(server) {
  state.view = 'server';
  state.currentServer = server;
  state.currentDM = null;
  renderServerRail();
  applyView();
  $('#server-name').textContent = server.name;

  const channels = await fetch(`/api/servers/${server.id}/channels`).then(r => r.json());
  state.channels = channels;
  renderChannels();

  const members = await fetch(`/api/servers/${server.id}/members`).then(r => r.json());
  state.members = members;
  renderMembers();

  if (state.socket) state.socket.emit('joinServer', server.id);

  if (channels.length) selectChannel(channels[0]);
  else { $('#messages').innerHTML = ''; $('#current-channel-name').textContent = '—'; }
}

function renderChannels() {
  const list = $('#channels-list');
  list.innerHTML = '';
  for (const c of state.channels) {
    const el = document.createElement('div');
    el.className = 'channel-item' + (state.currentChannel?.id === c.id ? ' active' : '');
    el.innerHTML = `<span class="hash">#</span><span>${escapeHtml(c.name)}</span>`;
    el.addEventListener('click', () => selectChannel(c));
    list.appendChild(el);
  }
}

async function selectChannel(channel) {
  state.currentChannel = channel;
  state.currentDM = null;
  state.typingUsers.clear();
  renderTyping();
  renderChannels();
  $('#chat-icon').textContent = '#';
  $('#current-channel-name').textContent = channel.name;
  $('#current-channel-topic').textContent = channel.topic || '';
  $('#message-input').placeholder = `Message #${channel.name}`;
  const msgs = await fetch(`/api/channels/${channel.id}/messages`).then(r => r.json());
  renderMessages(msgs);
  if (state.socket) state.socket.emit('joinChannel', channel.id);
}

let lastMessageMeta = null;
function renderMessages(msgs) {
  const c = $('#messages');
  c.innerHTML = '';
  lastMessageMeta = null;
  for (const m of msgs) appendMessage(m);
  c.scrollTop = c.scrollHeight;
}

function appendMessage(m) {
  const c = $('#messages');
  const compact = lastMessageMeta &&
    lastMessageMeta.user_id === m.user_id &&
    (m.created_at - lastMessageMeta.created_at) < 5 * 60 * 1000;
  const el = document.createElement('div');
  el.className = 'message' + (compact ? ' compact' : '');
  const initial = (m.username || '?')[0].toUpperCase();
  el.innerHTML = `
    <div class="avatar" style="background:${m.avatar_color || '#5865f2'}">${escapeHtml(initial)}</div>
    <div class="msg-body">
      <div class="msg-head">
        <span class="msg-author" style="color:${m.avatar_color || '#fff'}">${escapeHtml(m.username)}</span>
        <span class="msg-time">${formatTime(m.created_at)}</span>
      </div>
      <div class="msg-content">${linkify(escapeHtml(m.content))}</div>
    </div>`;
  c.appendChild(el);
  lastMessageMeta = m;
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 200;
  if (nearBottom) c.scrollTop = c.scrollHeight;
}

// ---------- COMPOSER ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text || !state.socket) return;
  if (state.currentDM) {
    state.socket.emit('dmMessage', { dmId: state.currentDM.id, content: text });
  } else if (state.currentChannel) {
    state.socket.emit('message', { channelId: state.currentChannel.id, content: text });
  }
  input.value = '';
});

$('#message-input').addEventListener('input', () => {
  if (!state.socket) return;
  if (state.currentDM) state.socket.emit('dmTyping', { dmId: state.currentDM.id });
  else if (state.currentChannel) state.socket.emit('typing', { channelId: state.currentChannel.id });
});

// ---------- ACTIONS ----------
$('#new-channel-btn').addEventListener('click', async () => {
  if (!state.currentServer) return;
  const name = prompt('Channel name (lowercase, a-z 0-9 -):');
  if (!name) return;
  const res = await fetch(`/api/servers/${state.currentServer.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    alert(e.error || 'Failed to create channel');
  } else {
    const c = await res.json();
    state.channels.push(c);
    renderChannels();
    selectChannel(c);
  }
});

$('#home-btn').addEventListener('click', () => openHome());
$('#open-friends-btn').addEventListener('click', () => { state.view = 'home'; applyView(); renderFriends(); });
$$('.ftab').forEach(t => t.addEventListener('click', () => {
  state.friendsTab = t.dataset.ftab;
  $$('.ftab').forEach(x => x.classList.toggle('active', x === t));
  renderFriendsBody();
}));
$('#add-server-btn').addEventListener('click', () => openCreateServerModal());
$('#empty-create').addEventListener('click', () => openCreateServerModal());
$('#join-server-btn').addEventListener('click', () => openJoinServerModal());
$('#empty-join').addEventListener('click', () => openJoinServerModal());
$('#invite-btn').addEventListener('click', () => openInviteModal());

function openCreateServerModal() {
  showModal({
    title: 'Create your server',
    body: `
      <p style="color:var(--text-secondary);font-size:14px;margin-bottom:8px;">
        Your server is where you and your friends hang out. You'll be the owner, and only people you invite can join.
      </p>
      <label>SERVER NAME</label>
      <input id="srv-name" placeholder="My Awesome Server" maxlength="40" autofocus />
    `,
    primary: { label: 'Create', onClick: async () => {
      const name = $('#srv-name').value.trim();
      if (!name) return;
      const res = await fetch('/api/servers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { alert('Failed to create'); return; }
      const srv = await res.json();
      closeModal();
      await loadServers(srv.id);
    }},
  });
}

function openJoinServerModal() {
  showModal({
    title: 'Join a server',
    body: `
      <p style="color:var(--text-secondary);font-size:14px;margin-bottom:8px;">
        Paste an invite link or code below to join.
      </p>
      <label>INVITE LINK</label>
      <input id="join-code" placeholder="https://your.host/invite/abc123 — or just abc123" autofocus />
      <div class="error" id="join-err" style="margin-top:8px"></div>
    `,
    primary: { label: 'Join', onClick: async () => {
      let code = $('#join-code').value.trim();
      if (!code) return;
      const m = code.match(/invite\/([\w-]+)/);
      if (m) code = m[1];
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        $('#join-err').textContent = e.error || 'Failed to join';
        return;
      }
      const { server } = await res.json();
      closeModal();
      await loadServers(server.id);
    }},
  });
}

async function openInviteModal() {
  if (!state.currentServer) return;
  showModal({
    title: `Invite friends to ${state.currentServer.name}`,
    body: `
      <p style="color:var(--text-secondary);font-size:14px;">
        Generate a link people can use to join this server. Anyone is on the outside until they redeem an invite.
      </p>
      <div style="display:flex;gap:12px;margin-top:12px;">
        <div style="flex:1"><label>EXPIRES IN (DAYS)</label>
          <input id="inv-days" type="number" value="7" min="1" max="365" />
        </div>
        <div style="flex:1"><label>MAX USES (BLANK = ∞)</label>
          <input id="inv-uses" type="number" min="1" placeholder="∞" />
        </div>
      </div>
      <div id="inv-result"></div>
    `,
    primary: { label: 'Generate Link', onClick: async () => {
      const days = Number($('#inv-days').value) || 7;
      const usesVal = $('#inv-uses').value.trim();
      const body = { expiresInDays: days };
      if (usesVal) body.maxUses = Number(usesVal);
      const res = await fetch(`/api/servers/${state.currentServer.id}/invites`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { alert('Failed'); return; }
      const { url } = await res.json();
      const out = $('#inv-result');
      out.innerHTML = `
        <label>YOUR INVITE LINK</label>
        <div class="invite-link-row">
          <input id="inv-link" readonly value="${escapeHtml(url)}" />
          <button id="copy-link">Copy</button>
        </div>`;
      $('#inv-link').select();
      $('#copy-link').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); } catch {}
        const b = $('#copy-link'); b.textContent = 'Copied!'; b.classList.add('copied');
        setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1500);
      });
    }, keepOpen: true },
    cancelLabel: 'Close',
  });
}

// ---------- MODAL ----------
function showModal({ title, body, primary, cancelLabel = 'Cancel' }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal">
      <div class="modal-header">${escapeHtml(title)}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">
        <button class="cancel">${escapeHtml(cancelLabel)}</button>
        ${primary ? `<button class="primary">${escapeHtml(primary.label)}</button>` : ''}
      </div>
    </div>`;
  root.classList.remove('hidden');
  root.querySelector('.cancel').addEventListener('click', closeModal);
  root.addEventListener('click', (e) => { if (e.target === root) closeModal(); }, { once: true });
  if (primary) {
    root.querySelector('.primary').addEventListener('click', async () => {
      try { await primary.onClick(); if (!primary.keepOpen) closeModal(); } catch (e) { console.error(e); }
    });
  }
  setTimeout(() => root.querySelector('input,textarea')?.focus(), 50);
}
function closeModal() { $('#modal-root').classList.add('hidden'); $('#modal-root').innerHTML = ''; }

// ---------- SOCKET ----------
function connectSocket() {
  const socket = io({ withCredentials: true });
  state.socket = socket;

  socket.on('message', (m) => {
    if (state.currentChannel && m.channel_id === state.currentChannel.id) appendMessage(m);
  });

  socket.on('channel:new', (c) => {
    if (state.currentServer && c.server_id === state.currentServer.id) {
      if (!state.channels.find(x => x.id === c.id)) {
        state.channels.push(c);
        renderChannels();
      }
    }
  });

  socket.on('member:join', ({ server_id, user }) => {
    if (state.currentServer && server_id === state.currentServer.id) {
      if (!state.members.find(m => m.id === user.id)) {
        state.members.push(user);
        renderMembers();
      }
    }
  });

  socket.on('presence', ({ server_id, online }) => {
    if (!state.currentServer || server_id !== state.currentServer.id) return;
    state.online = new Set(online.map(u => u.id));
    renderMembers();
  });

  socket.on('typing', ({ username, channelId }) => {
    if (!state.currentChannel || channelId !== state.currentChannel.id) return;
    if (username === state.me.username) return;
    state.typingUsers.add(username);
    renderTyping();
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => { state.typingUsers.clear(); renderTyping(); }, 3000);
  });

  socket.on('dmMessage', (m) => {
    if (state.currentDM && m.dm_id === state.currentDM.id) appendMessage(m);
  });

  socket.on('dmTyping', ({ username, dmId }) => {
    if (!state.currentDM || dmId !== state.currentDM.id) return;
    if (username === state.me.username) return;
    state.typingUsers.add(username);
    renderTyping();
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => { state.typingUsers.clear(); renderTyping(); }, 3000);
  });

  socket.on('dm:update', () => loadDMs());

  socket.on('friends:update', async () => {
    await loadFriends();
    if (state.view === 'home') renderFriendsBody();
  });

  socket.on('connect_error', (err) => console.warn('Socket:', err.message));
}

function renderTyping() {
  const el = $('#typing');
  const names = Array.from(state.typingUsers);
  if (!names.length) { el.textContent = ''; return; }
  if (names.length === 1) el.textContent = `${names[0]} is typing...`;
  else el.textContent = `${names.slice(0,3).join(', ')} are typing...`;
}

function renderMembers() {
  $('#member-count').textContent = state.members.length;
  const list = $('#members-list');
  list.innerHTML = '';
  const sorted = [...state.members].sort((a, b) => {
    const ao = state.online.has(a.id) ? 0 : 1;
    const bo = state.online.has(b.id) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.username.localeCompare(b.username);
  });
  for (const m of sorted) {
    const isOnline = state.online.has(m.id);
    const el = document.createElement('div');
    el.className = 'member' + (isOnline ? ' online' : '');
    const role = m.role === 'owner' ? '<span class="role-tag">OWNER</span>' : '';
    el.innerHTML = `
      <div class="avatar" style="background:${m.avatar_color};${isOnline ? '' : 'opacity:.4'}">${escapeHtml(m.username[0].toUpperCase())}</div>
      <div class="member-name">${escapeHtml(m.username)}</div>
      ${role}`;
    list.appendChild(el);
  }
}

// ---------- HOME / FRIENDS / DMs ----------
async function openHome() {
  state.view = 'home';
  state.currentServer = null;
  renderServerRail();
  applyView();
  await Promise.all([loadFriends(), loadDMs()]);
  renderFriends();
}

function applyView() {
  const home = state.view === 'home';
  $('#channels-header-server').classList.toggle('hidden', home);
  $('#channels-header-home').classList.toggle('hidden', !home);
  $('#channels-list').classList.toggle('hidden', home);
  $('#dms-list').classList.toggle('hidden', !home);
  $('#main-friends').classList.toggle('hidden', !(home && !state.currentDM));
  $('#main-chat').classList.toggle('hidden', home && !state.currentDM);
  $('#members-panel').classList.toggle('hidden', home);
  if (home) $('#server-name').textContent = '@me';
}

async function loadFriends() {
  state.friends = await fetch('/api/friends').then(r => r.json());
  const n = state.friends.incoming.length;
  $('#pending-badge').textContent = n ? n : '';
}

async function loadDMs() {
  state.dms = await fetch('/api/dms').then(r => r.json());
  renderDMList();
}

function renderDMList() {
  const list = $('#dms-list');
  list.innerHTML = '';
  if (!state.dms.length) {
    list.innerHTML = '<div class="empty-list-hint">No DMs yet. Add a friend to start one.</div>';
    return;
  }
  for (const d of state.dms) {
    const el = document.createElement('div');
    el.className = 'dm-item' + (state.currentDM?.id === d.id ? ' active' : '');
    el.innerHTML = `
      <div class="avatar" style="background:${d.other_avatar_color}">${escapeHtml(d.other_username[0].toUpperCase())}</div>
      <div class="dm-meta">
        <div class="dm-name">${escapeHtml(d.other_username)}</div>
        <div class="dm-last">${d.last_message ? escapeHtml(d.last_message).slice(0, 40) : 'No messages yet'}</div>
      </div>`;
    el.addEventListener('click', () => openDM(d));
    list.appendChild(el);
  }
}

async function openDM(dm) {
  state.currentDM = dm;
  state.currentChannel = null;
  state.view = 'home';
  state.typingUsers.clear();
  renderTyping();
  renderDMList();
  applyView();
  $('#chat-icon').textContent = '@';
  $('#current-channel-name').textContent = dm.other_username;
  $('#current-channel-topic').textContent = '';
  $('#message-input').placeholder = `Message @${dm.other_username}`;
  const msgs = await fetch(`/api/dms/${dm.id}/messages`).then(r => r.json());
  renderMessages(msgs);
  if (state.socket) state.socket.emit('joinDM', dm.id);
}

async function startDMWith(userId) {
  const res = await fetch('/api/dms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) { alert('Could not open DM'); return; }
  const dm = await res.json();
  if (!state.dms.find(x => x.id === dm.id)) state.dms.unshift(dm);
  state.view = 'home';
  state.currentServer = null;
  renderServerRail();
  await openDM(dm);
}

function renderFriends() {
  applyView();
  renderFriendsBody();
}

function renderFriendsBody() {
  const body = $('#friends-body');
  const tab = state.friendsTab;
  const me = state.me?.id;
  const onlineSet = state.online; // limited; presence is per-server in this build

  if (tab === 'add') {
    body.innerHTML = `
      <div class="add-friend-card">
        <h3>Add Friend</h3>
        <p>You can add friends with their Driven username.</p>
        <div class="row">
          <input id="add-friend-input" placeholder="username" autocomplete="off" />
          <button id="add-friend-send">Send Friend Request</button>
        </div>
        <div class="feedback" id="add-friend-feedback"></div>
      </div>`;
    const send = async () => {
      const username = $('#add-friend-input').value.trim();
      const fb = $('#add-friend-feedback');
      fb.className = 'feedback'; fb.textContent = '';
      if (!username) return;
      const res = await fetch('/api/friends/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) { fb.classList.add('err'); fb.textContent = data.error || 'Failed'; return; }
      fb.classList.add('ok');
      fb.textContent = data.status === 'accepted'
        ? `You and ${data.friend.username} are now friends!`
        : `Friend request sent to ${data.friend.username}.`;
      $('#add-friend-input').value = '';
      await loadFriends();
    };
    $('#add-friend-send').addEventListener('click', send);
    $('#add-friend-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return;
  }

  let rows = [];
  if (tab === 'pending') {
    const inc = state.friends.incoming.map(u => ({ ...u, kind: 'incoming' }));
    const out = state.friends.outgoing.map(u => ({ ...u, kind: 'outgoing' }));
    rows = [...inc, ...out];
  } else {
    rows = state.friends.accepted.map(u => ({ ...u, kind: 'accepted' }));
    if (tab === 'online') rows = rows.filter(u => onlineSet.has(u.id));
  }

  if (!rows.length) {
    const map = {
      all: 'No friends yet — go add some!',
      online: 'No friends online right now.',
      pending: 'No pending requests.',
    };
    body.innerHTML = `<div class="empty-list-hint" style="margin-top:40px;">${map[tab]}</div>`;
    return;
  }

  const heading = {
    all: `ALL FRIENDS — ${rows.length}`,
    online: `ONLINE — ${rows.length}`,
    pending: `PENDING — ${rows.length}`,
  }[tab];
  body.innerHTML = `<div class="friends-section-title">${heading}</div>` +
    rows.map(r => friendRowHTML(r)).join('');

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = btn.dataset.action;
      const id = Number(btn.dataset.id);
      const reqId = Number(btn.dataset.reqId);
      if (a === 'message') return startDMWith(id);
      if (a === 'accept') {
        await fetch(`/api/friends/${reqId}/accept`, { method: 'POST' });
      } else if (a === 'decline' || a === 'cancel') {
        await fetch(`/api/friends/${reqId}/decline`, { method: 'POST' });
      } else if (a === 'remove') {
        if (!confirm('Remove this friend?')) return;
        await fetch(`/api/friends/${id}`, { method: 'DELETE' });
      }
      await loadFriends();
      renderFriendsBody();
    });
  });
}

function friendRowHTML(r) {
  let actions = '';
  if (r.kind === 'incoming') {
    actions = `
      <button class="accept" data-action="accept" data-req-id="${r.request_id}" title="Accept">✓</button>
      <button class="danger" data-action="decline" data-req-id="${r.request_id}" title="Decline">✕</button>`;
  } else if (r.kind === 'outgoing') {
    actions = `<button class="danger" data-action="cancel" data-req-id="${r.request_id}" title="Cancel">✕</button>`;
  } else {
    actions = `
      <button data-action="message" data-id="${r.id}" title="Message">💬</button>
      <button class="danger" data-action="remove" data-id="${r.id}" title="Remove">✕</button>`;
  }
  const status = r.kind === 'incoming' ? 'Incoming Request'
              : r.kind === 'outgoing' ? 'Outgoing Request'
              : (state.online.has(r.id) ? 'Online' : 'Offline');
  return `
    <div class="friend-row">
      <div class="avatar" style="background:${r.avatar_color}">${escapeHtml(r.username[0].toUpperCase())}</div>
      <div class="friend-info">
        <div class="friend-name">${escapeHtml(r.username)}</div>
        <div class="friend-status">${status}</div>
      </div>
      <div class="friend-actions">${actions}</div>
    </div>`;
}

// ---------- UTILS ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Today at ${time}` : d.toLocaleDateString() + ' ' + time;
}
function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

tryAutoLogin();
