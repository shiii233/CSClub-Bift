'use strict'

/* ============================ 全局状态 ============================ */
const state = {
  boards: [],
  posts: [],
  members: { used: 0, max: 200, left: 200 },
  users: [],
  me: null,
  board: 'all',
  keyword: '',
  view: 'list',
  thread: null,
}
let token = localStorage.getItem('forum_token') || ''

/* ============================ 基础工具 ============================ */
const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const esc = (s) => String(s == null ? '' : s)

function toast(msg, kind) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'toast ' + (kind || '')
  setTimeout(() => t.classList.add('hidden'), 2600)
}

async function api(path, options) {
  const opts = Object.assign({ method: 'GET', headers: {} }, options || {})
  opts.headers['content-type'] = 'application/json'
  if (token) opts.headers['authorization'] = 'Bearer ' + token
  const res = await fetch(path, opts)
  return res.json()
}

function boardIdOf(name) {
  const b = state.boards.find((x) => x.name === name || x.id === name)
  return b ? b.id : null
}
function boardClass(id) {
  return id === 'chat' ? 'chat' : id === 'qa' ? 'qa' : 'study'
}

/* ============================ 数据加载 ============================ */
async function refresh() {
  const params = new URLSearchParams()
  if (state.board && state.board !== 'all') params.set('board', state.board)
  if (state.keyword) params.set('q', state.keyword)
  const data = await api('/api/state?' + params.toString())
  if (!data.ok) return toast(data.message || '加载失败', 'err')
  state.boards = data.boards
  state.posts = data.posts
  state.members = data.members
  state.users = data.users
  state.me = data.me
  if (!state.me && token) {
    token = ''
    localStorage.removeItem('forum_token')
  }
  renderSidebar()
  renderHead()
  if (state.thread) {
    const t = await api('/api/post?id=' + state.thread.id)
    if (t.ok) state.thread = t.post
    else state.thread = null
  }
  renderContent()
}

/* ============================ 侧边栏 / 顶栏 ============================ */
function renderHead() {
  $('#memberPill').textContent = `成员 ${state.members.used}/${state.members.max}`
  $('#clockPill').textContent = new Date().toLocaleString('zh-CN', { hour12: false })
  const box = $('#meBox')
  if (state.me) {
    box.textContent = `${state.me.username}${state.me.role === 'admin' ? ' · 管理员' : ' · 普通成员'}`
    box.className = 'me' + (state.me.role === 'admin' ? ' admin' : '')
  } else {
    box.textContent = '未注册 / 未登录'
    box.className = 'me'
  }
}

function renderSidebar() {
  const nav = $('#boardNav')
  nav.innerHTML = ''
  const all = el('button', 'board-btn' + (state.board === 'all' ? ' active' : ''))
  all.innerHTML = `<span><span class="b-name">全部帖子</span><span class="b-desc">不筛选板块，按时间倒序</span></span><span class="b-count">${state.posts.length || ''}</span>`
  all.onclick = () => {
    state.board = 'all'
    state.thread = null
    state.view = 'list'
    refresh()
  }
  nav.appendChild(all)

  for (const b of state.boards) {
    const btn = el('button', 'board-btn' + (state.board === b.id ? ' active' : ''))
    const count = state.posts.filter((p) => p.board === b.id).length
    btn.innerHTML = `<span><span class="b-name">${esc(b.name)}</span><span class="b-desc">${esc(b.desc)}</span></span><span class="b-count">${state.board === 'all' ? '' : count || ''}</span>`
    btn.onclick = () => {
      state.board = b.id
      state.thread = null
      state.view = 'list'
      refresh()
    }
    nav.appendChild(btn)
  }

  const card = $('#meCard')
  card.innerHTML = ''
  if (state.me) {
    card.innerHTML = `当前身份：<b>${esc(state.me.username)}</b><br>角色：<b>${state.me.role === 'admin' ? '管理员' : '普通成员'}</b><br>注册时间：${esc(state.me.createdAtText)}<br>账号位：<b>${state.members.used}/${state.members.max}</b>（余 ${state.members.left}）`
    const out = el('button', 'btn ghost small', '退出登录')
    out.style.marginTop = '8px'
    out.onclick = async () => {
      try {
        await api('/api/logout', { method: 'POST' })
      } catch (e) {
        /* 网络异常时也要清掉本地登录态 */
      }
      token = ''
      localStorage.removeItem('forum_token')
      state.me = null
      toast('已退出登录')
      refresh()
    }
    card.appendChild(out)
    if (state.me.role === 'admin') {
      const diag = el('button', 'btn ghost small', '访问诊断（内网/数据库）')
      diag.style.marginTop = '8px'
      diag.style.marginLeft = '6px'
      diag.onclick = openAccessModal
      card.appendChild(diag)
    }
  } else {
    card.innerHTML = `尚未注册。<br>可用指令：<b>注册：用户名xxx</b><br>或点击下方按钮注册。`
    const reg = el('button', 'btn primary small', '注册 / 登录')
    reg.style.marginTop = '8px'
    reg.onclick = openAuthModal
    card.appendChild(reg)
  }

  $('#memberCount').textContent = String(state.members.used)
  const list = $('#memberList')
  list.innerHTML = ''
  for (const u of state.users) {
    const chip = el('span', 'member-chip' + (u.role === 'admin' ? ' admin' : ''), u.username)
    list.appendChild(chip)
  }
  if (!state.users.length) list.appendChild(el('span', 'member-chip', '暂无成员'))
}

/* ============================ 正文渲染 ============================ */
function renderContent() {
  const box = $('#content')
  box.innerHTML = ''
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view))

  if (state.view === 'console') {
    $('#consoleDock').classList.remove('hidden')
    box.appendChild(el('div', 'notice info', '指令控制台已打开：在下方输入指令即可注册、发帖、按板块查看、查看楼层与回复。'))
    return
  }
  if (state.thread) return renderThread(box)
  renderList(box)
}

function renderList(box) {
  if (state.keyword) {
    box.appendChild(el('div', 'notice info', `已按关键词「${state.keyword}」筛选，共 ${state.posts.length} 条结果。`))
  }
  if (!state.posts.length) {
    box.appendChild(el('div', 'empty', '暂无帖子。点击「＋ 发帖」，或在指令控制台输入：发帖：板块=学习资料区，内容=xxx'))
    return
  }
  for (const p of state.posts) {
    const card = el('div', 'thread-card')
    const head = el('div', 'tc-head')
    if (p.pinned) head.appendChild(el('span', 'tc-pin', '置顶'))
    head.appendChild(el('span', 'tc-id', '#' + p.id))
    head.appendChild(el('span', 'tc-board ' + boardClass(p.board), p.boardName))
    head.appendChild(el('span', 'tc-author', p.author))
    head.appendChild(el('span', null, p.createdAtText))
    card.appendChild(head)

    card.appendChild(el('div', 'tc-title', p.title))
    if (p.content) card.appendChild(el('div', 'tc-body', p.content))
    for (const img of p.images) card.appendChild(el('span', 'imgtag', `【图片：${img}】`))

    const foot = el('div', 'tc-foot')
    foot.appendChild(el('span', null, `回复 ${p.replyCount} · 共 ${p.floorCount} 楼`))
    const open = el('button', 'mini-btn', `查看帖子ID:${p.id} 的全部回复 →`)
    open.onclick = (e) => {
      e.stopPropagation()
      openThread(p.id)
    }
    foot.appendChild(open)
    if (state.me && state.me.role === 'admin') {
      const pin = el('button', 'mini-btn', p.pinned ? '取消置顶' : '置顶')
      pin.onclick = (e) => {
        e.stopPropagation()
        adminAction({ action: 'pin', id: p.id })
      }
      const del = el('button', 'mini-btn', '删除')
      del.onclick = (e) => {
        e.stopPropagation()
        adminAction({ action: 'delete', id: p.id })
      }
      foot.appendChild(pin)
      foot.appendChild(del)
    }
    card.appendChild(foot)
    card.onclick = () => openThread(p.id)
    box.appendChild(card)
  }
}

async function openThread(id) {
  const data = await api('/api/post?id=' + id)
  if (!data.ok) return toast(data.message || '帖子不存在', 'err')
  state.thread = data.post
  state.view = 'list'
  renderContent()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function renderThread(box) {
  const p = state.thread
  const wrap = el('div', 'thread')

  const head = el('div', 'thread-head')
  const back = el('button', 'btn ghost small', '← 返回列表')
  back.onclick = () => {
    state.thread = null
    renderContent()
  }
  head.appendChild(back)
  head.appendChild(el('h2', null, `${p.title}`))
  const meta = el('div', 'tc-head')
  meta.appendChild(el('span', 'tc-id', '帖子 ID:' + p.id))
  meta.appendChild(el('span', 'tc-board ' + boardClass(p.board), p.boardName))
  meta.appendChild(el('span', null, `楼主 ${p.author} · ${p.createdAtText} · 共 ${p.floorCount} 楼`))
  head.appendChild(meta)
  wrap.appendChild(head)

  wrap.appendChild(floorNode(1, '楼主', p.author, p.createdAtText, p.content, p.images, true, null))

  for (const r of p.replies) {
    wrap.appendChild(floorNode(r.floor, '回复', r.author, r.createdAtText, r.content, r.images, false, r.replyTo))
  }

  const replyBox = el('div', 'reply-box')
  const label = el('div', 'hintline', `以 ${state.me ? state.me.username : '（未登录，请先注册）'} 的身份回复 · 目标：${p.floorCount + 1} 楼`)
  replyBox.appendChild(label)
  const ta = el('textarea')
  ta.rows = 3
  ta.placeholder = `回复帖子ID:${p.id}，内容=...（也可直接在此输入）`
  replyBox.appendChild(ta)
  const row = el('div', 'row-end')
  const btn = el('button', 'btn primary', '发布回复')
  btn.onclick = async () => {
    if (!ta.value.trim()) return toast('回复内容不能为空', 'err')
    const r = await api('/api/reply', { method: 'POST', body: JSON.stringify({ id: p.id, content: ta.value.trim() }) })
    if (!r.ok) return toast(r.message, 'err')
    toast(r.message, 'ok')
    ta.value = ''
    await refresh()
  }
  row.appendChild(btn)
  replyBox.appendChild(row)
  wrap.appendChild(replyBox)

  box.appendChild(wrap)
}

function floorNode(no, role, author, time, content, images, isOp, replyTo) {
  const f = el('div', 'floor ' + (isOp ? 'op' : 'reply'))
  const head = el('div', 'floor-head')
  head.appendChild(el('span', 'floor-no', `${no}楼`))
  head.appendChild(el('span', null, role))
  head.appendChild(el('span', 'floor-author', author))
  head.appendChild(el('span', null, time))
  if (replyTo) head.appendChild(el('span', null, `（回复 ${replyTo} 楼）`))
  f.appendChild(head)
  if (content) f.appendChild(el('div', 'floor-body', content))
  for (const img of images || []) f.appendChild(el('span', 'imgtag', `【图片：${img}】`))
  const meta = el('div', 'floor-meta')
  const quote = el('button', 'mini-btn', `回复此楼`)
  quote.onclick = () => {
    // 回复统一走指令控制台，手机端也能直接输入
    const input = $('#cmdInput')
    if (!input) return
    input.value = `回复帖子ID:${state.thread.id}，内容=`
    state.view = 'console'
    renderContent()
    $('#consoleDock').scrollIntoView({ behavior: 'smooth', block: 'end' })
    input.focus()
    try {
      input.setSelectionRange(input.value.length, input.value.length)
    } catch (e) {
      /* 忽略不支持 setSelectionRange 的环境 */
    }
  }
  meta.appendChild(quote)
  f.appendChild(meta)
  return f
}

/* ============================ 弹层：注册 / 发帖 ============================ */
function openModal(title, bodyNode) {
  $('#modalTitle').textContent = title
  const body = $('#modalBody')
  body.innerHTML = ''
  body.appendChild(bodyNode)
  $('#modal').classList.remove('hidden')
}
function closeModal() {
  $('#modal').classList.add('hidden')
}

function openAuthModal() {
  const wrap = el('div')
  const rowName = el('div', 'form-row')
  rowName.appendChild(el('label', null, '用户名（中文/字母/数字，最多 16 字）'))
  const input = el('input')
  input.placeholder = '例如：你的昵称'
  rowName.appendChild(input)
  wrap.appendChild(rowName)

  const rowPwd = el('div', 'form-row')
  rowPwd.appendChild(el('label', null, '密码（至少 6 位；已设密码的账号登录时必填）'))
  const pwd = el('input')
  pwd.type = 'password'
  pwd.placeholder = '建议设置，避免昵称被他人冒用'
  rowPwd.appendChild(pwd)
  wrap.appendChild(rowPwd)

  const rowCode = el('div', 'form-row')
  rowCode.appendChild(el('label', null, '管理员口令（普通成员留空即可）'))
  const code = el('input')
  code.placeholder = '仅管理员填写（FORUM_ADMIN_CODE）'
  rowCode.appendChild(code)
  wrap.appendChild(rowCode)

  wrap.appendChild(el('div', 'hintline', `当前有效账号 ${state.members.used}/${state.members.max}，剩余 ${state.members.left} 个名额。`))

  const acts = el('div', 'field-actions')
  const reg = el('button', 'btn primary', '注册并登录')
  reg.onclick = async () => {
    if (!input.value.trim()) return toast('请输入用户名', 'err')
    if (pwd.value && pwd.value.length < 6) return toast('密码至少 6 位', 'err')
    const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: input.value.trim(), password: pwd.value, adminCode: code.value.trim() }) })
    if (!r.ok) return toast(r.message, 'err')
    token = r.token
    localStorage.setItem('forum_token', token)
    toast(r.message, 'ok')
    closeModal()
    await refresh()
  }
  acts.appendChild(reg)

  const login = el('button', 'btn', '已有账号，登录')
  login.onclick = async () => {
    if (!input.value.trim()) return toast('请输入用户名', 'err')
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: input.value.trim(), password: pwd.value }) })
    if (!r.ok) return toast(r.message, 'err')
    token = r.token
    localStorage.setItem('forum_token', token)
    toast(r.message, 'ok')
    closeModal()
    await refresh()
  }
  acts.appendChild(login)
  wrap.appendChild(acts)
  openModal('注册 / 登录', wrap)
}

function openComposeModal() {
  const wrap = el('div')

  const rowBoard = el('div', 'form-row')
  rowBoard.appendChild(el('label', null, '板块'))
  const sel = el('select')
  for (const b of state.boards) {
    const o = el('option', null, b.name)
    o.value = b.id
    sel.appendChild(o)
  }
  if (state.board !== 'all') sel.value = state.board
  rowBoard.appendChild(sel)
  wrap.appendChild(rowBoard)

  const rowTitle = el('div', 'form-row')
  rowTitle.appendChild(el('label', null, '标题（可留空，自动截取内容）'))
  const title = el('input')
  title.placeholder = '例如：课程笔记/课件整理'
  rowTitle.appendChild(title)
  wrap.appendChild(rowTitle)

  const rowBody = el('div', 'form-row')
  rowBody.appendChild(el('label', null, '内容（支持【图片：说明】标记模拟图片）'))
  const ta = el('textarea')
  ta.rows = 6
  ta.placeholder = '例如：分享本周课程课件，重点看第二章【图片：课件首页截图】'
  rowBody.appendChild(ta)
  wrap.appendChild(rowBody)

  const rowImg = el('div', 'form-row')
  rowImg.appendChild(el('label', null, '模拟图片说明（可选，插入后不产生真实文件）'))
  const img = el('input')
  img.placeholder = '例如：第三章课件首页截图'
  rowImg.appendChild(img)
  const addImg = el('button', 'btn small', '插入【图片：说明】')
  addImg.onclick = () => {
    const desc = img.value.trim() || '未命名图片'
    ta.value = (ta.value.trim() + ` 【图片：${desc}】`).trim()
    img.value = ''
    ta.focus()
  }
  rowImg.appendChild(addImg)
  wrap.appendChild(rowImg)

  wrap.appendChild(el('div', 'hintline', '禁止发布违规、广告、外部引流内容；命中审核规则将被拦截。'))

  const acts = el('div', 'field-actions')
  const send = el('button', 'btn primary', '发布')
  send.onclick = async () => {
    if (!state.me) return toast('请先注册：注册：用户名xxx', 'err')
    if (!ta.value.trim()) return toast('内容不能为空', 'err')
    const r = await api('/api/post', {
      method: 'POST',
      body: JSON.stringify({ board: sel.value, title: title.value.trim(), content: ta.value.trim() }),
    })
    if (!r.ok) return toast(r.message, 'err')
    toast(r.message + (r.warn ? ' ' + r.warn : ''), 'ok')
    closeModal()
    await refresh()
    openThread(r.post.id)
  }
  acts.appendChild(send)
  wrap.appendChild(acts)

  openModal('发布新帖', wrap)
}

async function openAccessModal() {
  const data = await api('/api/access')
  const wrap = el('div')
  if (!data.ok) {
    wrap.appendChild(el('div', 'notice err', data.message || '仅管理员可查看访问诊断。'))
    return openModal('访问诊断（内网访问与数据库）', wrap)
  }

  const info = el('div', 'me-card')
  info.innerHTML =
    `监听地址：<b>${esc(data.bind)}:${esc(String(data.port))}</b><br>` +
    `数据存储：<b>${esc(data.store || '-')}</b>${data.storeWhere ? ` · ${esc(data.storeWhere)}` : ''}<br>` +
    (data.tablePrefix ? `表前缀：<b>${esc(data.tablePrefix)}</b><br>` : '') +
    `访问口令：<b>${esc(data.accessCode)}</b><br>` +
    `放行网段：<br><span class="cidr-list">${data.allowCidrs.map(esc).join('<br>')}</span>`
  wrap.appendChild(info)

  if (data.extraCidrs && data.extraCidrs.length) {
    wrap.appendChild(el('div', 'hintline', `其中来自 FORUM_ALLOW_CIDRS 的额外网段：${data.extraCidrs.join(' , ')}`))
  }

  wrap.appendChild(el('div', 'hintline', '若内网某台设备被拒，下表中会记录它的来源地址；把该地址所在网段加入 FORUM_ALLOW_CIDRS 后重启服务即可放行。'))

  if (!data.denied || !data.denied.length) {
    wrap.appendChild(el('div', 'notice info', '最近没有被拒绝的访问记录。'))
  } else {
    const table = el('table', 'access-table')
    const thead = el('thead')
    const hr = el('tr')
    for (const h of ['时间', '来源地址', '原因', '请求路径']) hr.appendChild(el('th', null, h))
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = el('tbody')
    for (const d of data.denied) {
      const tr = el('tr')
      tr.appendChild(el('td', 'mono', d.at))
      tr.appendChild(el('td', 'mono', d.ip))
      tr.appendChild(el('td', null, d.why))
      tr.appendChild(el('td', 'mono', d.path))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
  }

  openModal('访问诊断（内网访问与数据库）', wrap)
}

async function adminAction(payload) {
  const r = await api('/api/admin', { method: 'POST', body: JSON.stringify(payload) })
  toast(r.message, r.ok ? 'ok' : 'err')
  await refresh()
}

/* ============================ 指令控制台 ============================ */
const HELP = [
  '===== 指令说明（计算机社交流论坛） =====',
  '  注册：用户名xxx，密码=你的密码   注册并登录（上限 200 人）',
  '  登录：用户名xxx，密码=你的密码   换设备后登录已有账号',
  '  退出                              退出当前设备登录状态',
  '  发帖：板块=学习资料区，内容=xxx【图片：说明】',
  '      可选板块：【学习资料区】【闲聊交流区】【问答求助区】',
  '  查看全部帖子',
  '  查看板块【闲聊交流区】',
  '  查看帖子ID:1 的全部回复',
  '  回复帖子ID:1，内容=xxx',
  '  管理员：删除帖子ID:xx ／ 置顶帖子ID:xx ／ 封禁用户xxx ／ 清空全部数据',
].join('\n')

function appendConsole(text) {
  const out = $('#consoleOut')
  out.textContent += '\n\n' + text
  out.scrollTop = out.scrollHeight
}

async function runCommand(text) {
  const raw = String(text || '').trim()
  if (!raw) return
  const out = $('#consoleOut')
  out.textContent = (out.textContent.startsWith('点击右侧') ? '' : out.textContent) + `\n\n>>> ${raw}`
  out.scrollTop = out.scrollHeight

  const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ text: raw }) })
  if (r.token !== undefined) {
    if (r.token) {
      token = r.token
      localStorage.setItem('forum_token', token)
    } else if (r.token === null) {
      token = ''
      localStorage.removeItem('forum_token')
    }
  }
  appendConsole(r.text || '(无输出)')
  await refresh()

  // 手机端友好：回复成功后自动回到该帖楼层，不必再手动找
  const replied = raw.match(/^回复帖子\s*ID\s*[:：]?\s*(\d+)/i)
  if (r.ok && replied) {
    state.view = 'list'
    await openThread(Number(replied[1]))
  }
}

/* ============================ 事件绑定 ============================ */
function bind() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      state.view = t.dataset.view
      if (state.view === 'console') $('#consoleDock').scrollIntoView({ behavior: 'smooth', block: 'end' })
      renderContent()
    }
  })
  $('#composeBtn').onclick = openComposeModal
  $('#modalClose').onclick = closeModal
  $('#modal').onclick = (e) => {
    if (e.target.id === 'modal') closeModal()
  }
  $('#searchBtn').onclick = () => {
    state.keyword = $('#searchInput').value.trim()
    state.thread = null
    refresh()
  }
  $('#searchInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('#searchBtn').click()
  }
  $('#helpBtn').onclick = () => appendConsole(HELP)
  $('#cmdRun').onclick = () => {
    const v = $('#cmdInput').value
    $('#cmdInput').value = ''
    runCommand(v)
  }
  $('#cmdInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      $('#cmdRun').click()
    }
  }
  setInterval(() => {
    $('#clockPill').textContent = new Date().toLocaleString('zh-CN', { hour12: false })
  }, 1000)
}

bind()
refresh()
