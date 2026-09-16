// Reproducible marketing images: disposable profile + synthetic offline page only.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = await mkdtemp(path.resolve('.demo-readme-'));
const output = path.resolve('docs/images');
await mkdir(output, { recursive: true });
const demo = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>
body{margin:0;background:#fff;color:#263e35;font:16px 'Segoe UI','Microsoft YaHei UI',sans-serif}header{padding:24px 32px;border-bottom:1px solid #edf0eb;font-size:19px}small{float:right;font-size:13px;color:#77877b}main{max-width:690px;margin:55px auto}h1{font-size:28px}.question{background:#eef4e9;border-radius:20px;padding:20px;margin:28px 0 32px 100px}.answer{line-height:1.9}li{margin:12px 0}.composer{margin-top:50px;padding:20px;border:1px solid #dbe4d7;border-radius:20px;color:#7d8b80}.badge{color:#60775e;font-size:13px}</style>
<header>ChatGPT <small>离线演示 · 虚构内容</small></header><main><span class="badge">研究空间 / 产品构思</span><h1>让想法，从对话走向行动。</h1><div class="question">帮我把读书笔记整理成一份可执行的学习计划。</div><div class="answer">可以。我们把计划分成三个阶段：<ol><li><strong>梳理主题</strong>：提取每章的核心问题和关键概念。</li><li><strong>安排练习</strong>：每天选择一个主题，用自己的例子解释。</li><li><strong>回顾成果</strong>：每周复盘，并调整下一周的重点。</li></ol>你也可以让本机 Agent 继续整理文件和检查结果。</div><div class="composer">继续提问，或将下一步交给 Agent…</div></main></html>`;
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const {app}=require('electron'); app.setVersion(${JSON.stringify(version)}); app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(demo)},{headers:{'Content-Type':'text/html; charset=utf-8'}})));require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
const app = await electron.launch({ args: [bootstrap], env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.workspace);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  const rpc = (method, params = {}) => page.evaluate(({method,params}) => window.workspace.call(method,params),{method,params});
  for (const name of ['日常空间', '工作空间', '研究空间']) await rpc('accounts.create', { name });
  await page.waitForTimeout(1500);
  // Capture native window, including its embedded account view. Never the desktop.
  const capture = async name => {
    await page.waitForTimeout(450);
    const bytes = await app.evaluate(async ({BrowserWindow}) => [...(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()]);
    await writeFile(path.join(output, name + '.png'), Buffer.from(bytes));
  };
  await rpc('ui.visibility', { visible: false });
  // Native child views are omitted by capturePage on some platforms; reproduce
  // the same offline demo inside the renderer solely for this illustration.
  await page.locator('.browser-slot').evaluate((slot, html) => {
    const frame = document.createElement('iframe'); frame.srcdoc = html;
    frame.style.cssText = 'width:100%;height:100%;border:0;border-radius:12px';
    slot.append(frame);
  }, demo);
  await page.waitForTimeout(200);
  await page.frames()[1].evaluate(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(document.querySelector('style').textContent); document.adoptedStyleSheets = [sheet]; });
  await capture('workspace');
  await page.getByRole('button', { name: /任务中心/ }).click();
  await capture('tasks');
  await page.getByRole('button', { name: '设置与集成', exact: true }).click();
  // Redact even this disposable profile path before capturing settings.
  await page.locator('dd code').evaluateAll(elements => elements.forEach(e => { if (e.textContent.includes('agent-runtime.json')) e.textContent = '%APPDATA%/ChatGPT-Web-Client/agent-runtime.json'; }));
  await capture('settings');
  console.log('Saved three synthetic demo images to docs/images');
} finally { await app.close(); }
