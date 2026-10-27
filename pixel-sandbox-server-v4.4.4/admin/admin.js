// ============================================================
// Pixel Sandbox 管理中心 · 模块化脚本（V4.4.4v2）
// UI 采用宝塔式布局：左侧导航 + 顶栏 + 分页内容区。
// 每个功能区块 = 一个模块对象；HTML 用 data-module 标注页面。
// 顶层函数暴露到 window 供 onclick 调用。
// ============================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let cfg = {};
  let accountsCache = [];
  let playersCache = [];
  let currentAdmin = null; // 当前登录的管理账户 { user, role }

  // ---------- 基础工具 ----------
  async function post(u, b = {}) {
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let d = {};
    try { d = await r.json(); } catch (e) {}
    if (!r.ok || d.ok === false) throw new Error(d.message || d.error || '操作失败');
    return d;
  }
  async function shutdownServer() {
    if (!confirm('确认关闭游戏服务器？\n关闭后所有玩家将断开连接，服务器进程退出（若由进程管理器托管可能会自动重启）。')) return;
    try {
      const d = await post('/api/op/shutdown', {});
      alert((d && d.message) || '已发送关闭指令，服务器即将退出');
    } catch (e) { alert('关闭失败：' + e.message); }
  }
  function esc(v) {
    return String(v).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function clampPct(v) { v = Number(v); if (!Number.isFinite(v)) return 0; return Math.max(0, Math.min(100, v)); }
  function fmtUptime(sec) {
    sec = Number(sec) || 0;
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    if (d) return `${d} 天 ${h} 时`;
    if (h) return `${h} 时 ${m} 分`;
    if (m) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  // ---------- 模块：服务器终端 ----------
  // 多标签终端：默认“游戏命令终端”，可用“+ ”新建，并选择“游戏命令终端 / 系统终端”。
  // 系统终端需先输入密码 admin 解锁（UI 级二次确认；真正的服务端鉴权仍是 OP 登录令牌 /api/op/console）。
  const Term = {
    seq: 0,
    sessions: [],
    activeId: null,
    SYS_PASSWORD: 'admin',
    create(type) {
      type = (type === 'system') ? 'system' : 'game';
      const id = ++this.seq;
      const sess = {
        id, type,
        title: (type === 'system' ? '系统终端' : '游戏命令终端') + ' #' + id,
        cursor: 0,
        unlocked: type === 'game',
        elTab: null, elBody: null, outEl: null, inputEl: null,
        lockEl: null, lockInput: null, lockMsg: null,
      };
      this.sessions.push(sess);
      this._tab(sess);
      this._body(sess);
      this.activate(id);
      return sess;
    },
    activate(id) {
      this.activeId = id;
      this.sessions.forEach(s => {
        if (s.elTab) s.elTab.classList.toggle('active', s.id === id);
        if (s.elBody) s.elBody.classList.toggle('active', s.id === id);
      });
    },
    close(id) {
      const i = this.sessions.findIndex(s => s.id === id);
      if (i < 0) return;
      if (this.sessions.length <= 1) { this.append(id, { at: Date.now(), text: '至少需保留一个终端', level: 'WARN' }); return; }
      const s = this.sessions[i];
      if (s.elTab) s.elTab.remove();
      if (s.elBody) s.elBody.remove();
      this.sessions.splice(i, 1);
      if (this.activeId === id) this.activate(this.sessions[0].id);
    },
    _tab(sess) {
      const tabs = document.getElementById('termTabs'); if (!tabs) return;
      const tab = document.createElement('div');
      tab.className = 'term-tab' + (sess.type === 'system' ? ' sys' : '');
      tab.innerHTML = `<span class="term-tab-title">${esc(sess.title)}</span><button class="term-tab-close" title="关闭">✕</button>`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('term-tab-close')) { e.stopPropagation(); this.close(sess.id); }
        else this.activate(sess.id);
      });
      tabs.appendChild(tab);
      sess.elTab = tab;
    },
    _body(sess) {
      const bodies = document.getElementById('termBodies'); if (!bodies) return;
      const isSys = sess.type === 'system';
      const body = document.createElement('div');
      body.className = 'term-body';
      body.innerHTML = `
        <div class="console-out" id="consoleOut_${sess.id}"></div>
        ${isSys ? `<div class="term-lock" id="termLock_${sess.id}">
            <div class="term-lock-box">
              <div class="term-lock-title">🔒 系统终端已锁定</div>
              <p class="muted">系统终端需要使用密码 <code>admin</code> 解锁后才能执行指令。</p>
              <div class="formrow"><input class="console-input" id="termLockInput_${sess.id}" placeholder="输入密码 admin" type="password"><button class="btn primary" id="termLockBtn_${sess.id}">解锁</button></div>
              <div class="term-lock-msg" id="termLockMsg_${sess.id}"></div>
            </div>
          </div>` : ''}
        <div class="formrow" style="margin-top:10px">
          <input class="console-input" id="consoleInput_${sess.id}" placeholder="${isSys ? '解锁后可输入指令…' : '输入指令后回车，如 help / online / give 昵称 1 5 / say 文字'}" ${isSys ? 'disabled' : ''}>
          <button class="btn primary" id="termExecBtn_${sess.id}" ${isSys ? 'disabled' : ''}>执行</button>
          <button class="btn ghost" id="termClearBtn_${sess.id}">清屏</button>
        </div>`;
      bodies.appendChild(body);
      sess.elBody = body;
      sess.outEl = body.querySelector('#consoleOut_' + sess.id);
      sess.inputEl = body.querySelector('#consoleInput_' + sess.id);
      const execBtn = body.querySelector('#termExecBtn_' + sess.id);
      const clearBtn = body.querySelector('#termClearBtn_' + sess.id);
      if (execBtn) execBtn.addEventListener('click', () => this.exec(sess.id));
      if (clearBtn) clearBtn.addEventListener('click', () => this.clear(sess.id));
      if (sess.inputEl) sess.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.exec(sess.id); } });
      if (isSys) {
        sess.lockEl = body.querySelector('#termLock_' + sess.id);
        sess.lockInput = body.querySelector('#termLockInput_' + sess.id);
        sess.lockMsg = body.querySelector('#termLockMsg_' + sess.id);
        const lockBtn = body.querySelector('#termLockBtn_' + sess.id);
        const doUnlock = () => this.unlock(sess.id);
        if (lockBtn) lockBtn.addEventListener('click', doUnlock);
        if (sess.lockInput) sess.lockInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });
      }
    },
    async unlock(id) {
      const s = this.sessions.find(x => x.id === id); if (!s) return;
      const pwd = (s.lockInput && s.lockInput.value || '').trim();
      if (pwd !== this.SYS_PASSWORD) {
        if (s.lockMsg) { s.lockMsg.textContent = '密码错误，系统终端需要密码 admin'; s.lockMsg.classList.add('err'); }
        return;
      }
      s.unlocked = true;
      if (s.lockEl) s.lockEl.remove();
      if (s.inputEl) s.inputEl.disabled = false;
      const eb = s.elBody && s.elBody.querySelector('#termExecBtn_' + id);
      if (eb) eb.disabled = false;
      this.append(id, { at: Date.now(), text: '系统终端已解锁', level: 'CMD' });
    },
    async exec(id) {
      const s = this.sessions.find(x => x.id === id); if (!s || !s.inputEl) return;
      if (s.type === 'system' && !s.unlocked) {
        this.append(id, { at: Date.now(), text: '系统终端已锁定，请先输入密码 admin 解锁', level: 'WARN' });
        return;
      }
      const line = s.inputEl.value.trim(); if (!line) return;
      s.inputEl.value = '';
      this.append(id, { at: Date.now(), text: '> ' + line, level: 'CMD' });
      try {
        const d = await post('/api/op/console', { line });
        if (d.ok && d.output) this.append(id, { at: Date.now(), text: d.output });
        await this._pollOne(id);
      } catch (e) { this.append(id, { at: Date.now(), text: '错误：' + e.message, level: 'ERROR' }); }
    },
    clear(id) { const s = this.sessions.find(x => x.id === id); if (s && s.outEl) s.outEl.textContent = ''; },
    append(id, line) {
      const s = this.sessions.find(x => x.id === id); if (!s || !s.outEl) return;
      const cls = line.level === 'ERROR' ? 'err' : (line.level === 'WARN' ? 'warn' : (line.level === 'CMD' ? 'cmd' : ''));
      const t = new Date(line.at || Date.now()).toLocaleTimeString();
      s.outEl.insertAdjacentHTML('beforeend', `<div class="line ${cls}"><span class="t">${t}</span>${esc(line.text)}</div>`);
      s.outEl.scrollTop = s.outEl.scrollHeight;
    },
    async _pollOne(id) {
      const s = this.sessions.find(x => x.id === id); if (!s || !s.outEl) return;
      try {
        const d = await post('/api/op/console', { since: s.cursor });
        if (d.ok) {
          (d.lines || []).forEach(l => this.append(id, l));
          if (typeof d.cursor === 'number') s.cursor = d.cursor;
        }
      } catch (e) {}
    },
    async poll() {
      for (const s of this.sessions) { if (s.outEl) await this._pollOne(s.id); }
    },
    initAddMenu() {
      const btn = document.getElementById('termAddBtn');
      const menu = document.getElementById('termAddMenu');
      if (!btn || !menu) return;
      btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
      menu.querySelectorAll('button[data-type]').forEach(b => {
        b.addEventListener('click', () => { this.create(b.dataset.type); menu.hidden = true; });
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
      });
    }
  };

  // ---------- 模块：侧边导航 ----------
  const Nav = {
    titles: { status: '状态总览', players: '在线玩家', accounts: '账户管理', roles: '身份与模式', give: '发放物品', rules: '服务器规则', world: '世界与公告', console: '服务器终端', password: '管理密码', 'admin-accounts': '管理员账户' },
    init() {
      document.querySelectorAll('#sidebar .nav-item').forEach(el => {
        el.addEventListener('click', () => Nav.go(el.dataset.target));
      });
      Term.create('game');   // 默认“游戏命令终端”
      Term.initAddMenu();    // “+”新建终端菜单
    },
    go(mod) {
      if (!Nav.titles[mod]) return;
      document.querySelectorAll('#content .page').forEach(p => p.classList.toggle('active', p.dataset.module === mod));
      document.querySelectorAll('#sidebar .nav-item').forEach(n => n.classList.toggle('active', n.dataset.target === mod));
      const t = $('pageTitle'); if (t) t.textContent = Nav.titles[mod];
      if (mod === 'console') { try { Term.poll(); } catch (e) {} }
      if (mod === 'admin-accounts') { try { AdminAccounts.load(); } catch (e) {} }
    }
  };

  // ---------- 模块：登录 ----------
  const Login = {
    async login() {
      try {
        const d = await post('/api/op/login', { user: $('au') ? $('au').value : '', password: $('pw').value });
        if (d.ok) {
          currentAdmin = { user: d.user, role: d.role };
          $('login').style.display = 'none';
          $('panel').style.display = 'flex';
          renderAdminBadge();
          App.load(true);
          setInterval(() => App.load(false), 5000);
          setInterval(() => Term.poll(), 1200);
        }
      } catch (e) { alert(e.message); }
    }
  };

  // ---------- 模块：服务器状态（宝塔式圆环仪表盘） ----------
  const Status = {
    render(s) {
      const rings = [
        { label: 'CPU', val: clampPct(s.cpu), color: '#3ecf8e', sub: '实时占用' },
        { label: '内存', val: clampPct(s.memPercent), color: '#38bdf8', sub: (s.memUsedMB != null ? `${s.memUsedMB}/${s.memTotalMB} MB` : '—') },
        { label: '磁盘', val: clampPct(s.disk ? s.disk.percent : 0), color: '#f5a623', sub: (s.disk ? `${s.disk.usedGB}/${s.disk.totalGB} GB` : '—') }
      ];
      const metrics = [
        { icon: '🟢', label: '在线玩家', val: s.online ?? 0, target: 'players' },
        { icon: '🧱', label: '世界改动', val: s.worldChanges ?? 0, target: 'world' },
        { icon: '🚫', label: '封禁账户', val: s.banned ?? 0, target: 'accounts' },
        { icon: '🛡', label: '特权账号', val: s.privileged ?? 0, target: 'roles' }
      ];
      const info = [
        ['运行时长', fmtUptime(s.uptime)],
        ['游戏天数', `第 ${s.day ?? '-'} 天`],
        ['游戏时间', s.time ?? '-'],
        ['进程内存', (s.memoryMB ?? '-') + ' MB'],
        ['世界种子', s.seed ?? '-'],
        ['踢出记录', s.kicked ?? 0]
      ];
      $('status').innerHTML =
        `<div class="rings">${rings.map(r => `<div class="ring-card"><div class="ring" style="--p:${r.val};--c:${r.color}"><div class="ring-inner"><b>${r.val}%</b><span>${r.label}</span><i>${r.sub}</i></div></div></div>`).join('')}</div>` +
        `<div class="metric-grid">${metrics.map(m => `<div class="metric" style="cursor:pointer" title="点击进入：${m.label}" onclick="Nav.go('${m.target}')"><div class="m-ico">${m.icon}</div><div class="m-val">${m.val}</div><div class="m-label">${m.label}</div></div>`).join('')}</div>` +
        `<div class="info">${info.map(([k, v]) => `<div>${k}：<b>${v}</b></div>`).join('')}</div>` +
        `<div class="status-actions" style="margin-top:16px;display:flex;gap:10px;align-items:center"><button class="btn danger" onclick="shutdownServer()">⏻ 关闭游戏服务器</button><span class="muted">关闭后进程退出，需手动或经进程管理器重启</span></div>`;
    }
  };

  // ---------- 模块：服务器规则 ----------
  const Rules = {
    RULE_KEYS: [['pvp', '⚔️ PVP'], ['deathDrop', '☠️ 死亡掉落'], ['hungerEnabled', '🍖 饱食度'], ['nuclearEnabled', '☢️ 核工业'], ['chatEnabled', '💬 聊天'], ['creativeModeControl', '🔨 创造管控'], ['playerListDisplay', '👥 玩家列表'], ['mobilePerformance', '📱 移动端优化']],
    render() {
      $('rules').innerHTML = Rules.RULE_KEYS.map(([k, n]) => `<label class="rule"><input type=checkbox id="r_${k}" ${cfg[k] ? 'checked' : ''}>${n}</label>`).join('');
    },
    async save() {
      const body = {};
      Rules.RULE_KEYS.forEach(([k]) => body[k] = $(`r_${k}`).checked);
      await post('/api/op/config', body);
      alert('规则已保存'); App.load();
    }
  };

  // ---------- 模块：账户管理 ----------
  const Accounts = {
    render(list) {
      $('accounts').innerHTML = '<tr><th>UID</th><th>昵称</th><th>创建时间</th><th>操作</th></tr>' +
        list.map(a => `<tr><td>${esc(a.uid || '-')}</td><td>${esc(a.nickname)}</td><td>${new Date(a.createdAt).toLocaleString()}</td>` +
          `<td><button class="btn small" onclick="Admin.Accounts.reset('${esc(a.id)}')">重置密码</button>` +
          `<button class="btn small danger" onclick="Admin.Accounts.del('${esc(a.id)}')">删除</button></td></tr>`).join('');
    },
    async create() {
      try {
        await post('/api/op/account/create', { accountId: $('newAccountId').value, password: $('newAccountPw').value });
        $('newAccountId').value = ''; $('newAccountPw').value = '';
        alert('账户已创建'); App.load();
      } catch (e) { alert(e.message); }
    },
    async del(id) {
      if (!confirm('确认删除账户 ' + id + '？该账户玩家存档也会删除。')) return;
      try { await post('/api/op/account/delete', { accountId: id }); alert('账户已删除'); App.load(); }
      catch (e) { alert(e.message); }
    },
    async reset(id) {
      const pwd = prompt('输入新密码（至少6位）');
      if (pwd === null) return;
      try { await post('/api/op/account/reset-password', { accountId: id, password: pwd }); alert('密码已重置'); }
      catch (e) { alert(e.message); }
    }
  };

  // ---------- 模块：身份与创造模式 ----------
  const Roles = {
    refresh() {
      const rt = $('roleTarget'), ro = rt.value;
      rt.innerHTML = accountsCache.map(a => `<option value="${esc(a.uid)}">${esc(a.uid)} · ${esc(a.nickname)} · ${esc(a.role || 'player')} · ${esc(a.mode || 'survival')}</option>`).join('');
      if (accountsCache.some(a => a.uid === ro)) rt.value = ro; // 按 uid 还原选中项，避免定时刷新把已选目标清空（否则会以错误目标执行）
      this.renderPrivileged();
    },
    renderPrivileged() {
      const el = $('privileged'); if (!el) return;
      const list = accountsCache.filter(a => a.role === 'admin' || a.role === 'developer');
      const cnt = $('privCount'); if (cnt) cnt.textContent = list.length;
      el.innerHTML = '<tr><th>昵称</th><th>身份</th><th>操作</th></tr>' +
        (list.length
          ? list.map(a => `<tr><td>${esc(a.nickname)}</td><td>${esc(a.role)}</td><td><button class="btn small" onclick="Admin.Roles.setByAccount('${esc(a.nickname)}','player')">降为普通玩家</button></td></tr>`).join('')
          : '<tr><td colspan="3" class="muted">暂无特权账号</td></tr>');
    },
    async applyRole() {
      const uid = $('roleTarget').value, role = $('roleValue').value;
      try { await post('/api/op/setrole', { uid, role }); alert('身份已更新'); App.load(); }
      catch (e) { alert(e.message); }
    },
    async applyMode() {
      const uid = $('roleTarget').value, mode = $('modeValue').value;
      try { await post('/api/op/setmode', { uid, mode }); alert('模式已更新'); App.load(); }
      catch (e) { alert(e.message); }
    },
    async setByPlayer(id, role) { try { await post('/api/op/setrole', { id, role }); App.load(); } catch (e) { alert(e.message); App.load(); } },
    async setByAccount(nickname, role) { try { await post('/api/op/setrole', { nickname, role }); alert('身份已更新'); App.load(); } catch (e) { alert(e.message); } },
    async setModeByPlayer(id, mode) { try { await post('/api/op/setmode', { id, mode }); App.load(); } catch (e) { alert(e.message); App.load(); } }
  };

  // ---------- 模块：在线玩家 ----------
  const Players = {
    render(list) {
      $('players').innerHTML = '<tr><th>UID</th><th>昵称</th><th>身份</th><th>模式</th><th>状态</th><th>脚下坐标（格）</th><th>操作</th></tr>' +
        list.map(x => {
          const pos = x.coordinates || PlayerView.coordinates(x.x, x.y);
          return `<tr><td>${esc(x.uid || '-')}</td><td>${esc((x.prefix || '') + x.nickname)}</td>` +
            `<td><select onchange="Admin.Roles.setByPlayer(${x.id},this.value)"><option value="player" ${x.role === 'player' ? 'selected' : ''}>普通玩家</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>管理员</option><option value="developer" ${x.role === 'developer' ? 'selected' : ''}>开发者</option></select></td>` +
            `<td><select onchange="Admin.Roles.setModeByPlayer(${x.id},this.value)" ${x.role === 'player' ? 'disabled' : ''}><option value="survival" ${x.mode === 'survival' ? 'selected' : ''}>生存</option><option value="creative" ${x.mode === 'creative' ? 'selected' : ''}>创造</option></select></td>` +
            `<td>❤${Math.ceil(x.health)} 🍖${Math.ceil(x.hunger ?? 20)} 🛡${Math.round(x.armor || 0)}% Lv.${x.level || 1}</td>` +
            `<td>${pos ? `${pos.x},${pos.y}` : '—'}</td>` +
            `<td><button class="btn small" onclick="Admin.Players.kick(${x.id})">踢出</button><button class="btn small danger" onclick="Admin.Players.ban(${x.id})">封禁</button><button class="btn small ghost" onclick="selectTarget('${esc(x.accountId || '')}')">选中</button></td></tr>`;
        }).join('');
    },
    async kick(id) { await post('/api/op/kick', { id }); App.load(); },
    async ban(id) { if (confirm('确认封禁？')) { await post('/api/op/ban', { id }); App.load(); } }
  };

  // ---------- 模块：封禁账户（解禁） ----------
  const Bans = {
    async list() {
      const el = $('banlist'); if (!el) return;
      try {
        const d = await post('/api/op/banlist', {});
        const bans = d.bans || [];
        el.innerHTML = '<tr><th>昵称</th><th>原因</th><th>操作人</th><th>封禁时间</th><th>操作</th></tr>' +
          (bans.length
            ? bans.map(b => `<tr><td>${esc(b.nickname)}</td><td>${esc(b.reason || '')}</td><td>${esc(b.by || '')}</td>` +
              `<td>${esc(b.at ? new Date(b.at).toLocaleString() : '')}</td>` +
              `<td><button class="btn small" onclick="Admin.Bans.unban('${esc(b.nickname)}')">解禁</button></td></tr>`).join('')
            : '<tr><td colspan="5" class="muted">暂无被封禁的账户</td></tr>');
      } catch (e) { /* 忽略 */ }
    },
    async unban(nickname) {
      if (!confirm(`确认解禁「${nickname}」？解禁后该玩家可立即重新进入。`)) return;
      try {
        const d = await post('/api/op/unban', { nickname });
        if (d.ok) { alert('已解禁：' + nickname); this.list(); }
        else alert('解禁失败（可能已不在封禁列表）');
      } catch (e) { alert(e.message); }
    }
  };

  // ---------- 模块：发放物品（单个 / 批量） ----------
  const Give = {
    refreshTargets() {
      const sel = $('giveTarget'), old = sel.value;
      sel.innerHTML = accountsCache.map(a => `<option value="${esc(a.id)}">${esc(a.uid)} · ${esc(a.nickname)}${playersCache.some(p => p.accountId === a.id) ? ' · 在线' : ''}</option>`).join('');
      if (accountsCache.some(a => a.id === old)) sel.value = old;
    },
    async allOnline() {
      try { const pd = await (await fetch('/api/players')).json(); $('giveBatch').value = (pd.players || []).map(p => p.uid).join('\n'); }
      catch (e) {}
    },
    async grant() {
      const itemId = Number($('giveItemId').value) || Number($('giveItem').value);
      const count = Number($('giveCount').value) || 1;
      const batch = ($('giveBatch').value || '').split(/[\s,，;；]+/).map(s => s.trim()).filter(Boolean);
      const accountIds = batch.length ? batch : ($('giveTarget').value ? [$('giveTarget').value] : []);
      if (!accountIds.length) { alert('请选择或输入至少一个目标'); return; }
      try {
        const d = await post('/api/op/give', { accountIds, itemId, count });
        const names = d.results.map(r => r.nickname).join('、');
        $('giveResult').textContent = `已发放 ${itemId} × ${count} 给 ${d.total} 人：${names}`;
        alert(`已发放给 ${d.total} 人`);
        App.load();
      } catch (e) { alert(e.message); }
    }
  };

  // ---------- 模块：世界 / 公告 ----------
  const World = {
    api(u) { post(u, {}).then(() => App.load()); },
    reset() { if (confirm('确认清空世界差量？')) this.api('/api/reset'); },
    async resetNew() {
      if (!confirm('一键重置将：生成新世界种子、清空世界与所有玩家背包/进度（账户与昵称保留），并让在线玩家重新进入。确认继续？')) return;
      try {
        const d = await post('/api/op/hard-reset', {});
        alert(`世界已重置\n新种子：${d.seed}\n已踢下线：${d.kicked} 人`);
        App.load();
      } catch (e) { alert(e.message); }
    },
    async announce() { const text = $('announceInput').value.trim(); if (!text) return; await post('/api/op/announce', { text }); $('announceInput').value = ''; }
  };

  // ---------- 模块：数据备份 / 恢复 ----------
  const Backup = {
    async create() {
      try {
        const d = await post('/api/op/backup', {});
        alert(`已备份：${d.backup.name}\n${d.backup.files} 个文件，${(d.backup.size / 1024).toFixed(1)} KB\n保存位置：world/save`);
        this.list();
      } catch (e) { alert(e.message); }
    },
    async list() {
      const el = $('backups'); if (!el) return;
      try {
        const d = await post('/api/op/backups', {});
        const rows = (d.backups || []).map(b => {
          const size = (b.size / 1024).toFixed(1) + ' KB';
          const time = new Date(b.mtime).toLocaleString();
          return `<tr><td>${esc(b.name)}</td><td>${esc(time)}</td><td>${esc(size)}</td>` +
            `<td><button class="btn small" onclick="Backup.restore('${esc(b.name)}')">恢复</button> ` +
            `<button class="btn small ghost" onclick="Backup.download('${esc(b.name)}')">下载</button></td></tr>`;
        }).join('');
        el.innerHTML = '<tr><th>文件名</th><th>时间</th><th>大小</th><th>操作</th></tr>' +
          (rows || '<tr><td colspan="4" class="muted">暂无备份（点“立即备份”生成）</td></tr>');
      } catch (e) { /* 列表失败不打扰 */ }
    },
    async restore(name) {
      if (!confirm(`确认用备份「${name}」恢复世界与账户数据？\n当前未保存的改动会丢失。`)) return;
      try {
        const d = await post('/api/op/backup/restore', { name });
        alert(`已恢复 ${d.restored} 个文件`);
      } catch (e) { alert(e.message); }
    },
    async download(name) {
      try {
        const r = await fetch('/api/op/backup/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        if (!r.ok) throw new Error('下载失败');
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) { alert(e.message); }
    },
    async upload() {
      const f = $('backupFile') && $('backupFile').files[0];
      if (!f) { alert('请先选择 .zip 备份文件'); return; }
      if (!confirm('确认上传该备份并恢复？\n会覆盖世界 / 账户 / 数据目录。')) return;
      try {
        const r = await fetch('/api/op/restore', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f });
        const d = await r.json();
        if (!d.ok) throw new Error(d.message || '恢复失败');
        alert(`已恢复 ${d.restored} 个文件`);
        this.list();
      } catch (e) { alert(e.message); }
    }
  };

  // ---------- 模块：管理面板密码 ----------
  const Password = {
    async change() {
      const o = $('opOldPw').value, n = $('opNewPw').value, n2 = $('opNewPw2').value;
      if (!o || !n) { alert('请填写完整'); return; }
      if (n !== n2) { alert('两次输入的新密码不一致'); return; }
      try { await post('/api/op/change-password', { oldPassword: o, newPassword: n }); alert('密码已修改，请重新登录'); location.reload(); }
      catch (e) { alert(e.message); }
    }
  };

  // 当前登录管理员信息展示 + 超级管理员专属导航
  function renderAdminBadge() {
    const badge = $('adminBadge');
    if (badge && currentAdmin) {
      const roleText = currentAdmin.role === 'super' ? '最高权限' : '管理员';
      badge.textContent = '👤 ' + currentAdmin.user + '（' + roleText + '）';
    }
    const nav = $('navAdminAccounts');
    if (nav) nav.style.display = (currentAdmin && currentAdmin.role === 'super') ? '' : 'none';
  }

  // ---------- 模块：管理员账户（仅超级管理员可见/可用） ----------
  const AdminAccounts = {
    async load() {
      if (!currentAdmin || currentAdmin.role !== 'super') return;
      try {
        const d = await post('/api/op/admin-accounts');
        const el = $('adminAccountsList');
        if (!el) return;
        el.innerHTML = '<tr><th>账号</th><th>权限</th><th>操作</th></tr>' + (d.accounts || []).map(a =>
          '<tr><td>' + esc(a.user) + '</td><td>' + (a.role === 'super' ? '最高权限(super)' : '管理员(admin)') + '</td><td>' +
          (a.user === 'admin' ? '<span class="muted">默认账户</span>' :
            '<button class="btn small" onclick="Admin.AdminAccounts.setpw(\'' + esc(a.user) + '\')">重置密码</button>' +
            '<button class="btn small danger" onclick="Admin.AdminAccounts.del(\'' + esc(a.user) + '\')">删除</button>') +
          '</td></tr>'
        ).join('');
      } catch (e) { console.warn(e); }
    },
    async create() {
      const user = $('newAdminUser').value.trim(), pw = $('newAdminPw').value, role = $('newAdminRole').value;
      try { await post('/api/op/admin-account/create', { user, password: pw, role }); alert('账户已创建'); this.load(); }
      catch (e) { alert(e.message); }
    },
    async del(user) {
      if (!confirm('确认删除管理员账户 ' + user + '？')) return;
      try { await post('/api/op/admin-account/delete', { user }); alert('已删除'); this.load(); }
      catch (e) { alert(e.message); }
    },
    async setpw(user) {
      const pw = prompt('为 ' + user + ' 设置新密码（6-128 位）：');
      if (!pw) return;
      try { await post('/api/op/admin-account/set-password', { user, password: pw }); alert('密码已重置'); this.load(); }
      catch (e) { alert(e.message); }
    }
  };

  // ---------- 主控制器 ----------
  const App = {
    async load(force = false) {
      try {
        if (!force && document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
        const s = await (await fetch('/api/op/status')).json();
        if (!s.ok) return;
        cfg = s.config || {};
        Status.render(s);
        Rules.render();
        const chip = $('chipOnline'); if (chip) chip.textContent = '在线 ' + (s.online ?? 0);
        const pd = await (await fetch('/api/players')).json();
        playersCache = pd.players || [];
        const cnt = $('count'); if (cnt) cnt.textContent = pd.count || 0;
        Players.render(pd.players || []);
        const ad = await post('/api/op/accounts');
        accountsCache = ad.accounts || [];
        Accounts.render(ad.accounts || []);
        Give.refreshTargets();
        Roles.refresh();
        Backup.list();
        Bans.list();
        renderAdminBadge();
        if (currentAdmin && currentAdmin.role === 'super') AdminAccounts.load();
      } catch (e) { console.warn(e); }
    },
    selectTarget(id) {
      const el = $('giveTarget'); if (el) el.value = id;
      Nav.go('give');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // ---------- 暴露给 HTML onclick / onchange 的全局接口 ----------
  window.login = Login.login;
  window.load = App.load;
  window.saveRules = Rules.save;
  window.createAccount = Accounts.create;
  window.deleteAccount = Accounts.del;
  window.resetPassword = Accounts.reset;
  window.applyRole = Roles.applyRole;
  window.applyMode = Roles.applyMode;
  window.setRoleByPlayer = Roles.setByPlayer;
  window.setModeByPlayer = Roles.setModeByPlayer;
  window.setRoleByAccount = Roles.setByAccount;
  window.kick = Players.kick;
  window.ban = Players.ban;
  window.giveAllOnline = Give.allOnline;
  window.grantItem = Give.grant;
  window.api = (u) => World.api(u);
  window.resetWorld = () => World.reset();
  window.hardResetWorld = () => World.resetNew();
  window.announce = () => World.announce();
  window.Backup = Backup;
  window.changeOpPassword = Password.change;
  window.Term = Term;
  window.selectTarget = App.selectTarget;
  window.shutdownServer = shutdownServer;
  window.Admin = { Accounts, Roles, Players, Give, Bans, AdminAccounts };
  window.Nav = Nav;

  // ---------- 启动 ----------
  Nav.init();

  // 动态生成发放物品下拉：名称取自游戏 data.js 的 BLOCKS，保证与游戏内完全一致
  (function populateGiveItems() {
    const sel = $('giveItem'); if (!sel) return;
    sel.innerHTML = '';
    const og = document.createElement('optgroup'); og.label = '方块 / 工具 / 装备';
    const seen = new Set();
    if (typeof BLOCKS !== 'undefined') {
      Object.keys(BLOCKS).map(Number).sort((a, b) => a - b).forEach(id => {
        const b = BLOCKS[id];
        if (!b || !b.item) return;
        seen.add(id);
        const o = document.createElement('option'); o.value = id; o.textContent = id + ' · ' + b.name;
        og.appendChild(o);
      });
    }
    sel.appendChild(og);
    // BLOCK_NAMES 中存在、但 BLOCKS 未定义的"特殊物品"（食物 / 核材料），带真实中文名
    const specials = { 90: '苹果', 91: '面包', 92: '熟肉', 93: '金苹果', 97: '铀矿', 98: '浓缩铀', 99: '核燃料棒', 100: '核反应堆', 101: '冷却剂' };
    const sp = document.createElement('optgroup'); sp.label = '特殊物品';
    Object.keys(specials).map(Number).sort((a, b) => a - b).forEach(id => {
      if (seen.has(id)) return;
      const o = document.createElement('option'); o.value = id; o.textContent = id + ' · ' + specials[id];
      sp.appendChild(o);
    });
    sel.appendChild(sp);
  })();
})();
