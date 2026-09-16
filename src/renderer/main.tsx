import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Account, AgentTask, WorkspaceBridge, WorkspaceState } from '../shared/types';
import './style.css';
declare global { interface Window { workspace?: WorkspaceBridge } }
type Tab = 'workspace' | 'tasks' | 'settings';
type Modal = { kind: 'create' } | { kind: 'rename' | 'remove'; account: Account } | { kind: 'task'; task: AgentTask };
const taskLabels = { prompt: '提示词', snapshot: '页面快照', navigate: '页面导航', fill: '填写内容', click: '点击元素' };
const statusLabels = { pending: '等待中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' };

function App() {
  const bridge = window.workspace;
  const [state, setState] = useState<WorkspaceState>();
  const [tab, setTab] = useState<Tab>('workspace');
  const [modal, setModal] = useState<Modal>();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [submit, setSubmit] = useState(false);
  const refreshCounter = useRef(0);
  const active = state?.accounts.find(account => account.id === state.activeAccountId);
  async function refresh() {
    if (!bridge) return;
    const count = ++refreshCounter.current;
    const next = await bridge.call<WorkspaceState>('workspace.status');
    if (count === refreshCounter.current) setState(next);
  }
  useEffect(() => {
    if (!bridge) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(e => setError(String(e.message))); }, 40); };
    const off = bridge.onChange(update);
    void refresh().catch(e => setError(String(e.message)));
    return () => { clearTimeout(timer); off(); };
  }, [bridge]);
  useEffect(() => {
    void bridge?.call('ui.visibility', { visible: tab === 'workspace' && !modal }).catch(e => setError(String(e.message)));
  }, [bridge, tab, modal]);
  useEffect(() => {
    if (!modal) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setModal(undefined); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [modal, busy]);
  async function action(method: string, params: Record<string, unknown> = {}, after?: () => void) {
    if (!bridge) return;
    setBusy(true); setError('');
    try { await bridge.call(method, params); await refresh(); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)); }
    finally { setBusy(false); }
  }
  function openModal(next: Modal) { setError(''); setName(next.kind === 'rename' ? next.account.name : ''); setModal(next); }
  function accountForm(event: FormEvent) {
    event.preventDefault();
    if (!modal) return;
    const close = () => { setModal(undefined); setTab('workspace'); };
    if (modal.kind === 'create') void action('accounts.create', { name }, close);
    if (modal.kind === 'rename') void action('accounts.rename', { id: modal.account.id, name }, close);
    if (modal.kind === 'remove') void action('accounts.remove', { id: modal.account.id, confirmName: name }, close);
  }
  function createTask(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    void action('tasks.create', { accountId: active.id, input: { type: 'prompt', prompt, submit } }, () => setPrompt(''));
  }
  if (!bridge) return <div className="standalone"><span className="brand-mark">W</span><h1>请在桌面应用中打开</h1>
    <p>账号隔离和本地运行时由 Electron 提供。</p><code>npm run dev</code></div>;
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">W</span><div>ChatGPT Workspace<small>YOUR LOCAL AI DESKTOP</small></div></div>
      <nav aria-label="主导航">
        <button className={tab === 'workspace' ? 'nav active' : 'nav'} onClick={() => setTab('workspace')}><span>◈</span> 工作空间</button>
        <button className={tab === 'tasks' ? 'nav active' : 'nav'} onClick={() => setTab('tasks')}><span>☷</span> 任务中心 <b>{state?.tasks.filter(t => ['pending', 'running'].includes(t.status)).length || ''}</b></button>
      </nav>
      <div className="section-label">账号 <span>{state?.accounts.length ?? 0}</span></div>
      <div className="account-list">
        {state?.accounts.map((account, index) => <div key={account.id} className={`account-row ${active?.id === account.id ? 'selected' : ''}`}>
          <button className="account" disabled={busy} onClick={() => void action('accounts.switch', { id: account.id }, () => setTab('workspace'))}>
            <span className={`avatar tone-${index % 4}`}>{account.name.slice(0, 1).toUpperCase()}</span>
            <span className="account-name">{account.name}<small>{active?.id === account.id ? '当前工作空间' : '独立浏览器环境'}</small></span>
            {active?.id === account.id && <span className="active-dot" />}
          </button>
          <button className="account-edit" title={`管理 ${account.name}`} aria-label={`管理 ${account.name}`} onClick={() => openModal({ kind: 'rename', account })}>···</button>
        </div>)}
        <button className="add-account" onClick={() => openModal({ kind: 'create' })}>＋ 添加账号</button>
      </div>
      <div className="sidebar-footer">
        <div className="local-note"><span className="green-dot" /> 本地优先<small>登录状态留在此设备</small></div>
        <button className={tab === 'settings' ? 'nav active' : 'nav'} onClick={() => setTab('settings')}><span>⚙</span> 设置与集成</button>
        <div className="version">ChatGPT Web Client <span>v0.2.0</span></div>
      </div>
    </aside>
    <main>
      <header className="topbar">
        <div><span className="eyebrow">{tab === 'workspace' ? 'WORKSPACE' : tab === 'tasks' ? 'AGENT RUNTIME' : 'PREFERENCES'}</span>
          <h1>{tab === 'workspace' ? active?.name ?? '你的 AI 工作空间' : tab === 'tasks' ? '任务中心' : '设置与集成'}</h1></div>
        <span className="local-badge"><span className="green-dot" /> 本地运行</span>
      </header>
      <div className={`toolbar ${error ? 'has-error' : ''}`}>
        {error ? <><span role="alert">{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></>
        : tab === 'workspace' && active ? <>
          <button aria-label="后退" disabled={!state?.page?.canGoBack || busy} onClick={() => void action('browser.control', { accountId: active.id, action: 'back' })}>←</button>
          <button aria-label="前进" disabled={!state?.page?.canGoForward || busy} onClick={() => void action('browser.control', { accountId: active.id, action: 'forward' })}>→</button>
          <button aria-label="重新加载" disabled={busy} onClick={() => void action('browser.control', { accountId: active.id, action: 'reload' })}>↻</button>
          <span className="page-url">{state?.page?.loading ? '正在加载…' : state?.page?.url || 'https://chatgpt.com/'}</span>
          <button disabled={busy} onClick={() => void action('browser.navigate', { accountId: active.id, url: 'https://chatgpt.com/' })}>＋ 新对话</button>
        </> : <span>{tab === 'tasks' ? '为每个账号运行独立任务，结果仅保存在本机。' : tab === 'settings' ? '管理本地连接与数据。' : '每个账号都有独立的 Cookie、存储和会话。'}</span>}
      </div>
      {tab === 'workspace' && (!state || !active) && <section className="welcome">
        <div className="welcome-art"><span>✳</span><i className="orbit a">A</i><i className="orbit b">B</i><i className="orbit c">C</i></div>
        <span className="eyebrow">ONE DESKTOP. YOUR WORKSPACES.</span>
        <h2>让每个账号，<br />拥有自己的工作空间。</h2>
        <p>在一个桌面中使用多个 ChatGPT 账号。<br />独立登录，接续会话，连接你的本地 Agent。</p>
        <button className="primary" disabled={!state} onClick={() => openModal({ kind: 'create' })}>＋ 创建第一个账号</button>
        <div className="feature-row"><span>◈ 账号隔离</span><span>↻ 会话恢复</span><span>⌘ 本地自动化</span></div>
      </section>}
      {tab === 'workspace' && active && state?.page?.error && <section className="empty-state">
        <div className="empty-icon">↻</div><h2>页面暂时无法加载</h2><p>{state.page.error}</p><p>请检查网络连接，然后重新加载。</p>
        <button className="primary" onClick={() => void action('browser.control', { accountId: active.id, action: 'reload' })}>重新加载</button>
      </section>}
      {tab === 'tasks' && <section className="content tasks-page">
        <div className="page-heading"><div><h2>从想法，到行动</h2><p>选择账号后，将提示词交给它的浏览器。</p></div>
          <button className="secondary" disabled={!active || busy} onClick={() => void action('tasks.create', { accountId: active!.id, input: { type: 'snapshot' } })}>读取页面快照</button></div>
        <form className="card composer" onSubmit={createTask}>
          <label htmlFor="task-prompt">发给 <strong>{active?.name ?? '请先添加账号'}</strong></label>
          <textarea id="task-prompt" placeholder="希望这个工作空间帮你完成什么？" value={prompt} maxLength={32000} onChange={e => setPrompt(e.target.value)} disabled={!active} />
          <div className="composer-footer"><label className="check"><input type="checkbox" checked={submit} onChange={e => setSubmit(e.target.checked)} /> 发送给 ChatGPT 并等待回复</label>
            <button className="primary" disabled={!active || !prompt.trim() || busy}>{submit ? '发送并运行 ↗' : '填入草稿 ↗'}</button></div>
          <p className="hint">默认仅准备草稿。自动发送需要账号已登录；取消任务不会撤回已经发送的内容。</p>
        </form>
        <div className="list-heading"><h3>最近任务 <span>{state?.tasks.length ?? 0}</span></h3>
          <button className="text-button" disabled={busy || !state?.tasks.length || state.tasks.some(t => ['pending', 'running'].includes(t.status))} onClick={() => void action('tasks.clear')}>清空记录</button></div>
        {!state?.tasks.length ? <div className="card empty-tasks"><span>☷</span><h3>任务会出现在这里</h3><p>先准备一段提示词，或读取当前页面快照。</p></div>
        : <div className="task-list">{state.tasks.map(task => <div className="card task" key={task.id}>
          <div className={`task-icon ${task.status}`}>{task.input.type === 'prompt' ? '✳' : '⌘'}</div>
          <button className="task-summary" onClick={() => openModal({ kind: 'task', task })}><strong>{taskLabels[task.input.type]}</strong>
            <span>{task.input.type === 'prompt' ? task.input.prompt : task.input.type === 'navigate' ? task.input.url : task.input.type === 'snapshot' ? '读取当前页面的可见文本' : task.input.selector}</span>
            <small>{state.accounts.find(a => a.id === task.accountId)?.name ?? '已删除账号'} · {new Date(task.createdAt).toLocaleString()}</small></button>
          <span className={`status ${task.status}`}>{statusLabels[task.status]}</span>
          {['pending', 'running'].includes(task.status) && <button className="text-button" onClick={() => void action('tasks.cancel', { id: task.id })}>取消</button>}
        </div>)}</div>}
      </section>}
      {tab === 'settings' && <section className="content settings-page">
        <div className="page-heading"><div><h2>连接你的工作流</h2><p>向本机工具开放能力，由你决定何时启用。</p></div></div>
        <div className="card setting-card"><div className="setting-heading"><div><h3>本地 Agent API</h3><p>通过 CLI 或 HTTP 连接 AnythingCLI 等外部工具。</p></div>
          <button className={`toggle ${state?.api.enabled ? 'on' : ''}`} role="switch" aria-checked={state?.api.enabled ?? false} aria-label="启用本地 API" disabled={busy} onClick={() => void action('settings.api', { enabled: !state?.api.enabled })}><span /></button></div>
          <dl><dt>连接状态</dt><dd>{state?.api.enabled ? '已启用 · 仅本机可访问' : '已关闭'}</dd>
            <dt>服务地址</dt><dd><code>{state?.api.endpoint ?? '启用后自动分配端口'}</code></dd>
            <dt>连接配置</dt><dd><code>{state?.api.discoveryFile}</code></dd></dl>
          {state?.api.error && <p role="alert" className="error-text">{state.api.error}</p>}
          <p className="hint">连接配置包含私有令牌。CLI 自动读取；无需复制或上传。每次启动服务都会更换令牌。</p>
        </div>
        <div className="card setting-card"><h3>命令行快速开始</h3><p>在项目目录中构建后，运行：</p>
          <pre>node dist-electron/cli.cjs accounts{'\n'}node dist-electron/cli.cjs snapshot &lt;account-id&gt;{'\n'}node dist-electron/cli.cjs prompt &lt;account-id&gt; "你好" --submit --wait</pre>
          <p className="hint">输入 --help 查看完整用法。接口文档位于 docs/API.md。</p></div>
        <div className="card setting-card"><h3>你的数据，你的设备</h3><p>账号资料、任务记录和窗口状态保存在本地 SQLite 数据库。登录状态保存在各自的 Chromium 分区。删除账号会清除该账号的登录数据与任务记录。</p>
          <p className="hint">此客户端独立开发，与 OpenAI 无隶属关系。ChatGPT 网页及第三方登录的可用性由对应服务决定。麦克风、摄像头等网页权限默认关闭。</p></div>
      </section>}
    </main>
    {modal && <div className="modal-backdrop" onClick={() => { if (!busy) setModal(undefined); }}>
      <dialog open className="modal" aria-labelledby="modal-title" onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Tab') {
          const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
          const first = items[0], last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <button className="modal-close" aria-label="关闭弹窗" disabled={busy} onClick={() => setModal(undefined)}>×</button>
        <h2 id="modal-title">{modal.kind === 'create' ? '添加一个工作空间' : modal.kind === 'rename' ? '管理账号' : modal.kind === 'remove' ? '删除账号？' : '任务详情'}</h2>
        {modal.kind === 'task' ? <><p>{statusLabels[(state?.tasks.find(t => t.id === modal.task.id) ?? modal.task).status]}</p>
          <pre className="task-result">{JSON.stringify(state?.tasks.find(t => t.id === modal.task.id) ?? modal.task, null, 2)}</pre></>
        : <form onSubmit={accountForm}>
          <p>{modal.kind === 'remove' ? `这会清除「${modal.account.name}」的登录状态、浏览器数据和任务记录。输入完整账号名称确认。` : '为账号起一个容易辨认的名字。添加后，在网页中自行登录。'}</p>
          <label htmlFor="account-name">{modal.kind === 'remove' ? '确认账号名称' : '账号名称'}</label>
          <input id="account-name" autoFocus required maxLength={60} placeholder="例如：个人、工作、研究" value={name} onChange={e => setName(e.target.value)} />
          {error && <p role="alert" className="error-text">{error}</p>}
          <div className="modal-actions">
            {modal.kind === 'rename' && <button className="danger-text" type="button" onClick={() => openModal({ kind: 'remove', account: modal.account })}>删除账号</button>}
            <button className="secondary" type="button" disabled={busy} onClick={() => setModal(undefined)}>取消</button>
            <button className={modal.kind === 'remove' ? 'danger' : 'primary'} disabled={busy || !name.trim() || (modal.kind === 'remove' && name !== modal.account.name)}>{busy ? '处理中…' : modal.kind === 'create' ? '创建账号' : modal.kind === 'remove' ? '确认删除' : '保存'}</button>
          </div>
        </form>}
      </dialog>
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
