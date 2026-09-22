import packageInfo from '../../package.json';
import { Updates } from './components/Updates';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Account, AgentPromptTarget, AgentTask, TaskChoice, WorkspaceBridge, WorkspaceState } from '../shared/types';
import { Icon, Logo } from './components/Icon';
import { Titlebar } from './components/Titlebar';
import { Select } from './components/Select';
import { TaskCenter, statusLabels, phaseLabels } from './components/TaskCenter';
import { ShortcutEditor } from './components/ShortcutEditor';
import { accountActivity, ReplyBadge, NotificationList } from './components/AccountActivity';
import { AgentPromptPanel } from './components/AgentPromptPanel';
import { AgentPreview } from './components/AgentPreview';
import { TaskDecision } from './components/TaskDecision';
import { ConversationQueue } from './components/ConversationQueue';
import { isQueueTask } from '../shared/conversationQueue';
import { Toast } from './components/Toast';
import { friendlyError } from './errors';
import './style.css';
import { taskAttentionCopy } from '../shared/taskAttentionCopy';
declare global { interface Window { workspace?: WorkspaceBridge } }
type Tab = 'workspace' | 'tasks' | 'settings';
type Modal = { kind: 'create' } | { kind: 'rename' | 'remove' | 'notifications'; account: Account } | { kind: 'task'; task: AgentTask } | { kind: 'agent'; target: AgentPromptTarget };

function App() {
  const bridge = window.workspace;
  const [state, setState] = useState<WorkspaceState>();
  const [tab, setTab] = useState<Tab>('workspace');
  const [modal, setModal] = useState<Modal>();
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<{ id: number; message: string }>();
  const noticeCounter = useRef(0);
  const setError = useCallback((value: string) => {
    if (!value) { setNotice(undefined); return; }
    const message = friendlyError(value);
    const id = ++noticeCounter.current;
    setNotice(previous => previous?.message === message ? previous : { id, message });
  }, []);
  const dismissNotice = useCallback(() => setNotice(undefined), []);
  const [busy, setBusy] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueDrafts, setQueueDrafts] = useState<Record<string, string>>({});
  const [focusMode, setFocusMode] = useState(() => {
    try { return localStorage.getItem('workspace.focusMode') === 'true'; } catch { return false; }
  });
  const focused = focusMode && tab === 'workspace';
  const actionPending = useRef(false);
  const refreshCounter = useRef(0);
  const browserSlot = useRef<HTMLDivElement>(null);
  const active = state?.accounts.find(account => account.id === state.activeAccountId);
  useEffect(() => {
    if (!focused || !state?.accounts.length || modal) setAccountMenuOpen(false);
  }, [focused, state?.accounts.length, modal]);
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
    // Native account views sit above the renderer, including portaled menus.
    void bridge?.call('ui.visibility', { visible: tab === 'workspace' && !modal && !accountMenuOpen }).catch(e => setError(String(e.message)));
  }, [bridge, tab, modal, accountMenuOpen]);
  useEffect(() => {
    const slot = browserSlot.current;
    if (!bridge || !slot) return;
    const update = () => {
      const { x, y, width, height } = slot.getBoundingClientRect();
      void bridge.call('ui.bounds', { x, y, width, height }).catch(e => setError(String(e.message)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(slot);
    update();
    return () => observer.disconnect();
  }, [bridge, tab, active?.id, focused]);
  useEffect(() => {
    try { localStorage.setItem('workspace.focusMode', String(focusMode)); } catch { /* Keep the toggle usable if storage is unavailable. */ }
  }, [focusMode]);
  useEffect(() => bridge?.onShortcut(shortcut => {
    if (shortcut.type === 'takeover') { if (active && state?.pages.some(page => page.accountId === active.id && page.selected && page.locked)) takeover(active.id); return; }
    if (modal || accountMenuOpen || actionPending.current) return;
    if (shortcut.type === 'focus') {
      setTab('workspace');
      setFocusMode(current => !current);
      return;
    }
    const accounts = state?.accounts ?? [];
    if (!accounts.length) return;
    const current = accounts.findIndex(account => account.id === state?.activeAccountId);
    const index = shortcut.type === 'account' ? shortcut.index
      : (current + shortcut.direction + accounts.length) % accounts.length;
    const account = accounts[index];
    if (account) void action('accounts.switch', { id: account.id }, () => setTab('workspace'));
  }), [bridge, state, modal, accountMenuOpen]);
  useEffect(() => {
    if (!modal) return;
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-select-content]')) return;
      if (event.key === 'Escape' && !busy) setModal(undefined);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [modal, busy]);
  async function action(method: string, params: Record<string, unknown> = {}, after?: () => void) {
    if (!bridge || actionPending.current) return;
    actionPending.current = true;
    setBusy(true); setError('');
    try { await bridge.call(method, params); await refresh(); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  function openModal(next: Modal) { setError(''); setName(next.kind === 'rename' ? next.account.name : ''); setModal(next); }
  async function openPageAgent(accountId: string) {
    if (!bridge || actionPending.current) return;
    actionPending.current = true; setBusy(true); setError('');
    try {
      // Snapshot the live selection, but unsupported pages must not block starting a new consultation.
      const live = await bridge.call<WorkspaceState>('workspace.status');
      const selected = live.pages.find(page => page.accountId === accountId && page.selected);
      const url = selected?.url;
      openModal({ kind: 'agent', target: { accountId, ...(/^https:\/\/chatgpt.com\/c\/[\w-]+\/?$/.test(url ?? '') ? { url } : {}) } });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  function accountForm(event: FormEvent) {
    event.preventDefault();
    if (!modal) return;
    const close = () => { setModal(undefined); setTab('workspace'); };
    if (modal.kind === 'create') void action('accounts.create', { name }, close);
    if (modal.kind === 'rename') void action('accounts.rename', { id: modal.account.id, name }, close);
    if (modal.kind === 'remove') void action('accounts.remove', { id: modal.account.id, confirmName: name }, close);
  }
  const takingOver = useRef(false);
  function takeover(accountId: string, conversationId?: string) {
    const targetPage = conversationId ? state?.pages.find(page => page.accountId === accountId && page.conversationId === conversationId) : state?.pages.find(page => page.accountId === accountId && page.selected);
    const conversation = conversationId ?? targetPage?.conversationId;
    if (!conversation && !targetPage?.locked) return;
    if (!bridge || takingOver.current) return;
    takingOver.current = true;
    void (async () => {
      try {
        await bridge.call('queues.takeover', { accountId, conversation });
        if (targetPage) await bridge.call('browser.select', { accountId, pageId: targetPage.id });
        else await bridge.call('accounts.switch', { id: accountId });
        setModal(undefined); setTab('workspace'); await refresh();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { takingOver.current = false; }
    })();
  }
  function choose(task: AgentTask, choice: TaskChoice) {
    if (!task.attention) return;
    if (choice === 'takeover') { takeover(task.accountId, task.conversationId); return; }
    void action('tasks.decide', { id: task.id, token: task.attention.id, choice }, () => setModal(undefined));
  }
  const activePage = state?.pages.find(page => page.accountId === active?.id && page.selected);
  const accountPages = state?.pages.filter(page => page.accountId === active?.id) ?? [];
  const runningTask = state?.tasks.find(task => task.id === activePage?.taskId && task.status === 'running');
  const attentionTasks = state?.tasks.filter(task => task.attention && !task.resolvedAt) ?? [];
  const attentionTask = attentionTasks.find(task => task.id === activePage?.taskId || task.accountId === active?.id && !!task.conversationId && task.conversationId === activePage?.conversationId);
  const pageLocked = !!activePage?.locked;
  const previewTask = runningTask ?? attentionTask;
  const showPreview = tab === 'workspace' && !!active && pageLocked;
  const previewStatus = (previewTask ? taskAttentionCopy(previewTask)?.title : undefined) ?? phaseLabels[previewTask?.phase ?? 'preparing'];
  const modalTask = modal?.kind === 'task' ? state?.tasks.find(task => task.id === modal.task.id) ?? modal.task : undefined;
  if (!bridge) return <div className="standalone"><Logo /><h1>请在桌面应用中打开</h1>
    <p>请启动 ChatGPT Web Client 使用账号和对话功能。</p></div>;
  const queueCount = state?.tasks.filter(task => task.accountId === active?.id && !!activePage?.conversationId && task.conversationId === activePage.conversationId && isQueueTask(task) && !task.sendIntentAt).length ?? 0;
  function closeQueue() { setQueueOpen(false); requestAnimationFrame(() => document.getElementById('queue-toggle')?.focus()); }
  return <div className={`app ${focused ? 'focus-mode' : ''} ${queueOpen && tab === 'workspace' ? 'queue-open' : ''}`}>
    <Titlebar bridge={bridge} onError={setError} />
    <aside className="sidebar">
      <div className="brand"><Logo /><div>Workspace<small>多账号客户端</small></div></div>
      <div className="nav-label">工作台</div>
      <nav aria-label="主导航">
        <button className={tab === 'workspace' ? 'nav active' : 'nav'} aria-current={tab === 'workspace' ? 'page' : undefined} onClick={() => setTab('workspace')}><Icon name="grid" /> 工作空间 <Icon name="arrow" className="nav-arrow" size={15} /></button>
        <button className={tab === 'tasks' ? 'nav active' : 'nav'} aria-current={tab === 'tasks' ? 'page' : undefined} onClick={() => setTab('tasks')}><Icon name="tasks" /> 任务中心 <b title={attentionTasks.length ? `${attentionTasks.length} 个任务需要处理` : '执行中的任务'}>{state?.tasks.filter(t => ['pending', 'running'].includes(t.status) || t.attention && !t.resolvedAt).length || ''}</b></button>
      </nav>
      <div className="section-label"><span>我的账号 <b>{state?.accounts.length ?? 0}</b></span><Icon name="lock" size={13} /></div>
      <div className="account-list">
        {state?.accounts.length === 0 && <div className="accounts-empty"><div className="account-placeholders"><span /><span /><span /></div><p>还没有账号</p></div>}
        {state?.accounts.map((account, index) => <div key={account.id} className={`account-row ${active?.id === account.id ? 'selected' : ''}`}>
          <button className="account" disabled={busy} title={account.name} aria-current={active?.id === account.id ? 'true' : undefined} onClick={() => void action('accounts.switch', { id: account.id }, () => setTab('workspace'))}>
            <span className="account-avatar"><span className={`avatar tone-${index % 4}`}>{account.name.slice(0, 1).toUpperCase()}</span>{accountActivity(state, account.id).running && <span className="conversation-spinner" role="status" aria-label={`${account.name} 会话运行中`} />}</span>
            <span className="account-name">{account.name}<small>{accountActivity(state, account.id).running ? '正在回复' : '独立登录'}</small></span>
            {active?.id === account.id && <span className="active-dot" />}
          </button>
          <ReplyBadge account={account} count={accountActivity(state, account.id).count} onClick={() => openModal({ kind: 'notifications', account })} />
          <button className="account-edit" title={`管理 ${account.name}`} aria-label={`管理 ${account.name}`} onClick={() => openModal({ kind: 'rename', account })}><Icon name="more" size={17} /></button>
        </div>)}
        <button className="add-account" onClick={() => openModal({ kind: 'create' })}><Icon name="plus" size={16} /> 添加账号</button>
      </div>
      <div className="sidebar-footer">
        <div className="local-note"><Icon name="shield" size={20} /><div>本机存储<small>独立登录 · 本地保存</small></div><span className="green-dot" /></div>
        <Updates bridge={bridge} compact openSettings={() => setTab('settings')} />
        <button className={tab === 'settings' ? 'nav active' : 'nav'} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}><Icon name="settings" /> 设置与集成</button>
        <div className="version">ChatGPT Web Client <span>v{packageInfo.version}</span></div>
      </div>
    </aside>
    <main>
      <header className="topbar">
        <div className="page-title"><span className="header-icon"><Icon name={tab === 'workspace' ? 'grid' : tab === 'tasks' ? 'tasks' : 'settings'} size={20} /></span><div>
          <h1>{tab === 'workspace' ? active?.name ?? 'ChatGPT 账号' : tab === 'tasks' ? '任务中心' : '设置与集成'}</h1></div></div>
        <span className="local-badge"><span className="green-dot" /> 本地运行</span>
      </header>
      <div className="toolbar">
        {tab === 'workspace' && <button className="focus-toggle" aria-pressed={focused} title={`${focused ? '退出' : '进入'}专注模式`} onClick={() => setFocusMode(current => !current)}><Icon name={focused ? 'restore' : 'maximize'} size={16} />{focused ? '退出专注' : '专注模式'}</button>}
        {focused && !!state?.accounts.length && <Select className="focus-account" label="切换账号" value={active?.id ?? ''} disabled={busy}
          options={state.accounts.map(account => ({ value: account.id, label: account.name }))}
          open={accountMenuOpen} onOpenChange={setAccountMenuOpen} onValueChange={id => void action('accounts.switch', { id })} />}
        {focused && active && <><ReplyBadge account={active} count={accountActivity(state, active.id).count} onClick={() => openModal({ kind: 'notifications', account: active })} />{accountActivity(state, active.id).running && <span className="conversation-spinner" aria-label="会话运行中" />}</>}
        {tab === 'workspace' && active ? <>
          <button aria-label="后退" title="后退" disabled={!state?.page?.canGoBack || busy || pageLocked} onClick={() => void action('browser.control', { accountId: active.id, action: 'back' })}><Icon name="back" size={16} /></button>
          <button aria-label="前进" title="前进" disabled={!state?.page?.canGoForward || busy || pageLocked} onClick={() => void action('browser.control', { accountId: active.id, action: 'forward' })}><Icon name="arrow" size={16} /></button>
          <button aria-label="重新加载" title="重新加载" disabled={busy || pageLocked} onClick={() => void action('browser.control', { accountId: active.id, action: 'reload' })}><Icon name="refresh" size={16} className={state?.page?.loading ? 'spinning' : ''} /></button>
          <span className="page-url"><Icon name="lock" size={13} /><span>{state?.page?.loading ? '正在加载…' : state?.page?.url || 'https://chatgpt.com/'}</span></span>
          <button id="queue-toggle" className={`queue-toggle ${queueOpen ? 'selected' : ''}`} aria-expanded={queueOpen} aria-label={`会话队列${queueCount ? `，${queueCount} 条待发送` : ''}`} onClick={() => setQueueOpen(value => !value)}><Icon name="tasks" size={15} /> 会话队列{queueCount > 0 && <b>{queueCount}</b>}</button>
          <button className="agent-toolbar" disabled={busy} onClick={() => void openPageAgent(active.id)}><Icon name="terminal" size={15} /> Agent 协作</button>
          <button className="new-chat" disabled={busy} onClick={() => void action('browser.newConversation', { accountId: active.id })}><Icon name="plus" size={15} /> 新对话</button>
        </> : <span className="toolbar-note"><Icon name={tab === 'tasks' ? 'terminal' : tab === 'settings' ? 'lock' : 'shield'} size={14} />{tab === 'tasks' ? '按账号和会话管理队列' : tab === 'settings' ? '快捷键、接口和数据设置' : '添加账号后登录 ChatGPT'}</span>}
      </div>
      {tab === 'workspace' && active && accountPages.length > 1 && <div className="conversation-tabs" role="tablist" aria-label="打开的会话">{accountPages.map(page => <div className={`conversation-tab ${page.selected ? 'selected' : ''}`} key={page.id}>
        <button role="tab" aria-selected={page.selected} title={page.title} onClick={() => void action('browser.select', { accountId: active.id, pageId: page.id })}>{page.locked ? <span className="preview-dot" /> : <Icon name="chat" size={14} />}<span>{page.title}</span></button>
        <button aria-label={`关闭会话 ${page.title}`} disabled={page.locked || busy} onClick={() => void action('browser.closePage', { accountId: active.id, pageId: page.id })}><Icon name="close" size={12} /></button>
      </div>)}</div>}
      {tab === 'workspace' && (showPreview || !!attentionTask) && <div className={`workspace-status ${showPreview && runningTask?.status === 'running' ? 'is-running' : ''} ${attentionTask ? 'attention-banner' : ''}`}>
        <div className="workspace-status-label" role="status">
          <span aria-hidden="true" className={`preview-dot ${!showPreview || previewTask?.attention ? 'needs-attention' : ''}`} />
          <span className="workspace-status-text" title={showPreview ? previewStatus : attentionTask && !pageLocked ? '当前页面可操作，该会话有暂停的任务等待你的选择' : '其他会话或账号有任务等待处理，不影响当前页面'}>{showPreview ? previewStatus : attentionTask && !pageLocked ? '当前页面可操作 · 此会话任务待处理' : '当前页面可操作 · 其他任务待处理'}</span>
          {showPreview && <span className="preview-mode" title="自动跟随最新回复。需要浏览历史或操作网页时，请选择接管。">只读预览 · 自动跟随</span>}
        </div>
        <div className="workspace-status-actions">
          {attentionTask && (attentionTask.status === 'waiting_user' && !pageLocked && attentionTask.attention?.choices.some(choice => choice.id === 'retry')
            ? <button className="attention-chip" onClick={() => choose(attentionTask, 'retry')}>交还 Agent 并继续<Icon name="arrow" size={13} /></button>
            : <button className="attention-chip" aria-label="选择如何处理" title="处理当前会话的任务" onClick={() => openModal({ kind: 'task', task: attentionTask })}>处理任务<Icon name="arrow" size={13} /></button>)}
          {showPreview && <>
            <button className="status-detail" onClick={() => { if (previewTask) openModal({ kind: 'task', task: previewTask }); else setTab('tasks'); }}>查看任务</button>
            <button className="status-takeover" title="暂停此会话队列并接管网页操作" onClick={() => takeover(active!.id)}>接管</button>
          </>}
        </div>
      </div>}
      {tab === 'workspace' && active && <div className={`workspace-body ${queueOpen ? 'with-queue' : ''}`}>
        <div className="browser-slot" ref={browserSlot}>{pageLocked && <AgentPreview key={activePage?.id} bridge={bridge} accountId={active.id} pageId={activePage?.id} />}</div>
        {queueOpen && activePage && state && <ConversationQueue key={`${active.id}:${activePage.id}`} account={active} page={activePage} state={state} bridge={bridge}
          drafts={queueDrafts} changeDraft={(key, text) => setQueueDrafts(values => ({ ...values, [key]: text }))}
          clearDraft={(key, text) => setQueueDrafts(values => values[key] === text ? { ...values, [key]: '' } : values)} refresh={refresh} close={closeQueue}
          inspect={task => openModal({ kind: 'task', task })} takeover={takeover} />}
      </div>}
      {tab === 'workspace' && (!state || !active) && <section className="welcome">
        <div className="welcome-body"><div className="welcome-art"><div className="orbit-ring" /><div className="logo-tile"><Logo /></div><span className="orbit-label orbit-personal"><span className="mini-avatar">P</span> 个人账号 <span className="green-dot" /></span><span className="orbit-label orbit-work"><span className="mini-avatar warm">W</span> 工作账号 <Icon name="check" size={12} /></span></div>

        <h2>在这里管理 ChatGPT 账号</h2>
        <p>每个账号单独登录，保留各自的会话。<br />添加账号后即可打开 ChatGPT。</p>
        <button className="primary welcome-cta" disabled={!state} onClick={() => openModal({ kind: 'create' })}><Icon name="plus" size={18} /> 创建第一个账号 <Icon name="arrow" size={17} /></button>
        <span className="welcome-caption">支持添加多个账号，登录状态相互独立。</span></div>
        <div className="feature-row"><div><Icon name="shield" size={21} /><span><strong>独立登录</strong><small>登录与数据互不干扰</small></span></div><div><Icon name="refresh" size={21} /><span><strong>继续上次对话</strong><small>重新打开时恢复上次页面</small></span></div><div><Icon name="terminal" size={21} /><span><strong>本地接口</strong><small>支持 HTTP 和命令行</small></span></div></div>
      </section>}
      {tab === 'workspace' && active && !pageLocked && state?.page?.error && <section className="empty-state">
        <div className="empty-icon"><Icon name="refresh" size={32} /></div><h2>页面暂时无法加载</h2><p>{friendlyError(state.page.error)}</p><p>请检查网络连接，然后重新加载。</p>
        <button className="primary" onClick={() => void action('browser.control', { accountId: active.id, action: 'reload' })}>重新加载</button>
      </section>}
      {tab === 'tasks' && <TaskCenter state={state} busy={busy} action={action} inspect={task => openModal({ kind: 'task', task })} takeover={takeover} agentPrompt={target => openModal({ kind: 'agent', target })}
        openQueue={(accountId, conversation) => void action('conversations.open', { accountId, conversation }, () => { setTab('workspace'); setQueueOpen(true); })} />}
      {tab === 'settings' && <section className="content settings-page">
        <div className="page-heading"><div><h2>设置</h2><p>管理快捷键、本地接口和账号数据。</p></div><span className="settings-emblem"><Icon name="terminal" size={30} /></span></div>
        <Updates bridge={bridge} />
        <ShortcutEditor bridge={bridge} config={state?.shortcuts} busy={busy} action={action} />
        <div className="card setting-card"><div className="setting-heading"><div><h3>本地 Agent API</h3><p>通过 CLI 或 HTTP 连接 AnythingCLI 等外部工具。</p></div>
          <button className={`toggle ${state?.api.enabled ? 'on' : ''}`} role="switch" aria-checked={state?.api.enabled ?? false} aria-label="启用本地 API" disabled={busy} onClick={() => void action('settings.api', { enabled: !state?.api.enabled })}><span /></button></div>
          <dl><dt>连接状态</dt><dd>{state?.api.enabled ? '已启用 · 仅本机可访问' : '已关闭'}</dd>
            <dt>服务地址</dt><dd><code>{state?.api.endpoint ?? '启用后自动分配端口'}</code></dd>
            <dt>连接配置</dt><dd><code>{state?.api.discoveryFile}</code></dd></dl>
          {state?.api.error && <p role="alert" className="error-text">{friendlyError(state.api.error)}</p>}
          <p className="hint">连接配置包含私有令牌。CLI 自动读取；无需复制或上传。每次启动服务都会更换令牌。</p>
        </div>
        <details className="card setting-card integration-details"><summary><span><Icon name="terminal" size={19} /> 命令行快速开始</span><Icon name="plus" size={17} /></summary><p>在项目目录中构建后，运行：</p>
          <pre>node dist-electron/cli.cjs accounts{'\n'}node dist-electron/cli.cjs snapshot &lt;account-id&gt;{'\n'}node dist-electron/cli.cjs prompt &lt;account-id&gt; "你好" --new --submit --wait</pre>
          <p className="hint">输入 --help 查看完整用法。接口文档位于 docs/API.md。</p></details>
        <div className="card setting-card privacy-card"><Icon name="shield" size={25} /><div><h3>数据存储</h3><p>账号资料、对话位置和任务记录都保存在这台设备。每个账号拥有独立的登录空间；删除账号时，它的登录数据与任务记录也会一起清除。</p>
          <p className="hint">此客户端独立开发，与 OpenAI 无隶属关系。ChatGPT 网页及第三方登录的可用性由对应服务决定。麦克风、摄像头等网页权限默认关闭。</p></div></div>
      </section>}
    </main>
    {notice && <Toast key={notice.id} message={notice.message} dismiss={dismissNotice} />}
    {modal && <div className="modal-backdrop" onClick={() => { if (!busy) setModal(undefined); }}>
      <dialog open className={`modal ${modal.kind === 'agent' ? 'agent-modal' : ''}`} aria-labelledby="modal-title" onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Tab') {
          const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')];
          const first = items[0], last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <button className="modal-close" aria-label="关闭弹窗" disabled={busy} onClick={() => setModal(undefined)}><Icon name="close" size={20} /></button>
        <div className="modal-emblem"><Icon name={modal.kind === 'agent' ? 'terminal' : modal.kind === 'notifications' ? 'chat' : modal.kind === 'task' ? 'tasks' : modal.kind === 'remove' ? 'shield' : 'plus'} size={25} /></div>
        <h2 id="modal-title">{modal.kind === 'agent' ? 'Agent 协作' : modal.kind === 'notifications' ? '待处理会话' : modal.kind === 'create' ? '添加账号' : modal.kind === 'rename' ? '管理账号' : modal.kind === 'remove' ? '删除账号？' : '任务详情'}</h2>
        {modal.kind === 'agent' ? <AgentPromptPanel bridge={bridge} state={state} initial={modal.target} action={action} busy={busy} notifyError={setError} /> : modal.kind === 'notifications' ? <><NotificationList account={modal.account} notices={state?.notifications ?? []} busy={busy} action={action} opened={() => { setModal(undefined); setTab('workspace'); }} /></> : modal.kind === 'task' ? <><p className="hint">{state?.accounts.find(account => account.id === modalTask?.accountId)?.name} · {state?.conversations.find(item => item.id === modalTask?.conversationId)?.title ?? modalTask?.targetUrl ?? '新会话'}</p>{modalTask?.attention && <TaskDecision task={modalTask} busy={busy} choose={choice => choose(modalTask, choice)} />}<p>{statusLabels[(state?.tasks.find(t => t.id === modal.task.id) ?? modal.task).status]}</p>
          <details open={!modalTask?.attention}><summary>任务记录</summary><pre className="task-result">{JSON.stringify(modalTask, null, 2)}</pre></details></>
        : <form onSubmit={accountForm}>
          <p>{modal.kind === 'remove' ? `这会取消「${modal.account.name}」尚未发送的任务，并清除它的登录状态、浏览器数据和任务记录。输入完整账号名称确认。` : '为账号起一个容易辨认的名字。添加后，在网页中自行登录。'}</p>
          <label htmlFor="account-name">{modal.kind === 'remove' ? '确认账号名称' : '账号名称'}</label>
          <input id="account-name" autoFocus required maxLength={60} placeholder="例如：个人、工作、研究" value={name} onChange={e => setName(e.target.value)} />
          {modal.kind === 'rename' && <button type="button" className="secondary account-agent-entry" onClick={() => openModal({ kind: 'agent', target: { accountId: modal.account.id } })}><Icon name="terminal" size={16} /> 生成 Agent 提示词</button>}
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
