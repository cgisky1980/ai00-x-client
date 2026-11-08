/**
 * CDP driver for the workbench chat-panel acceptance test (throwaway).
 *
 * Usage: node test/cdp-drive.mjs <step>
 *   probe-login    — dump login page buttons
 *   login          — click the 免登录/quick-enter button
 *   targets        — list CDP targets
 *   open-workbench — from /main page, open the workbench window
 *   probe-wb       — dump workbench window state (cards, chat panel)
 *   select         — click first project preview (emits active-project)
 *   chat-state     — dump chat panel state + session binding
 *   send <text>    — type into chat composer and submit
 *   watch <sec>    — watch chat messages grow for N seconds
 */
const BASE = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  return await res.json();
}

let msgId = 0;
async function attach(target, onEvent) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (!m.id && onEvent) {
      onEvent(m);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, (m) =>
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'page exception: ' +
          (r.exceptionDetails.exception?.description ||
            JSON.stringify(r.exceptionDetails)).slice(0, 800),
      );
    }
    return r.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

async function waitFor(fn, timeout = 30000, step = 500, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting: ${label}`);
    await sleep(step);
  }
}

async function findTarget(match) {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'page' && match(t));
}

const step = process.argv[2];
const arg = process.argv.slice(3).join(' ');

try {
  if (step === 'targets') {
    for (const t of await listTargets()) {
      console.log(`${t.type} | ${t.title} | ${t.url}`);
    }
  } else if (step === 'probe-login') {
    const target = await findTarget((t) => t.url.includes('/login'));
    if (!target) throw new Error('no login page');
    const c = await attach(target);
    console.log(
      await c.ev(`JSON.stringify([...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean))`),
    );
    c.close();
  } else if (step === 'login') {
    const target = await findTarget((t) => t.url.includes('/login'));
    if (!target) throw new Error('no login page');
    const c = await attach(target);
    const clicked = await c.ev(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(x => x.textContent.includes('免登录'));
      if (!hit) return null;
      hit.click();
      return hit.textContent.trim();
    })()`);
    console.log('clicked:', clicked);
    c.close();
  } else if (step === 'open-workbench') {
    const target = await waitFor(
      () => findTarget((t) => t.url.includes('/main')),
      60000,
      500,
      'main page',
    );
    const c = await attach(target);
    await waitFor(
      () => c.ev(`Boolean(window.__TAURI__ && window.__TAURI__.core)`),
      15000,
      500,
      '__TAURI__',
    );
    console.log(await c.ev(`window.__TAURI__.core.invoke('open_app_window', {id: 'workbench'}).then(() => 'ok').catch(e => 'ERR: ' + e)`));
    c.close();
  } else if (step === 'console-watch') {
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target, (m) => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        console.log(`[console.${m.params.type}]`, String(text).slice(0, 400));
      } else if (m.method === 'Runtime.exceptionThrown') {
        console.log('[exception]', JSON.stringify(m.params).slice(0, 400));
      }
    });
    await c.send('Runtime.enable');
    await sleep((Number(arg) || 60) * 1000);
    c.close();
  } else if (step === 'eval-file') {
    const { readFileSync } = await import('node:fs');
    const expr = readFileSync(arg, 'utf8');
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target);
    console.log(JSON.stringify(await c.ev(expr), null, 1));
    c.close();
  } else if (step === 'eval') {
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target);
    console.log(JSON.stringify(await c.ev(arg), null, 1));
    c.close();
  } else if (step === 'eval-main') {
    // 在主窗口（http://127.0.0.1:2100/main/）里执行表达式
    const target = await findTarget((t) => t.url.endsWith('/main/'));
    if (!target) throw new Error('no main page');
    const c = await attach(target);
    console.log(JSON.stringify(await c.ev(arg), null, 1));
    c.close();
  } else if (step === 'eval-at') {
    // 在指定 URL 片段命中的页面里执行表达式：eval-at <urlSubstring> <expr>
    const [urlPart, ...rest] = arg.split(/\s+/);
    const expr = arg.slice(urlPart.length + 1);
    const target = await findTarget((t) => t.url.includes(urlPart));
    if (!target) throw new Error(`no page matching ${urlPart}`);
    const c = await attach(target);
    console.log(JSON.stringify(await c.ev(expr), null, 1));
    c.close();
  } else if (step === 'shot-at') {
    // 截取指定页面：shot-at <urlSubstring> <file>
    const { writeFileSync } = await import('node:fs');
    const [urlPart, file] = arg.split(/\s+/);
    const target = await findTarget((t) => t.url.includes(urlPart));
    if (!target) throw new Error(`no page matching ${urlPart}`);
    const c = await attach(target);
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved:', file);
    c.close();
  } else if (step === 'shot') {
    // 截取工作台窗口：node test/cdp-drive.mjs shot <file> [x,y,w,h]
    const { writeFileSync } = await import('node:fs');
    const [file, clipArg] = arg.split(/\s+/, 2);
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target);
    const params = { format: 'png' };
    if (clipArg) {
      const [x, y, width, height] = clipArg.split(',').map(Number);
      params.clip = { x, y, width, height, scale: 3 };
    }
    const r = await c.send('Page.captureScreenshot', params);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved:', file);
    c.close();
  } else if (step === 'drag') {
    // 拖拽分隔条：node test/cdp-drive.mjs drag <selector> <dx>
    const [selector, dxArg] = arg.split(/\s+/, 2);
    const dx = Number(dxArg) || 0;
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target);
    const rect = await c.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) };
    })()`);
    if (!rect) {
      console.log('no handle');
    } else {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await c.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1,
      });
      const steps = 8;
      for (let i = 1; i <= steps; i += 1) {
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: rect.x + (dx * i) / steps,
          y: rect.y,
          button: 'left',
        });
        await sleep(30);
      }
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x + dx,
        y: rect.y,
        button: 'left',
        clickCount: 1,
      });
      await sleep(300);
      console.log('dragged', selector, 'by', dx);
    }
    c.close();
  } else if (step === 'click') {
    // 真实鼠标点击：click <selector>（在元素中心派发 mousePressed/Released）
    const target = await findTarget((t) => t.url.includes('workbench.html'));
    if (!target) throw new Error('no workbench window');
    const c = await attach(target);
    const rect = await c.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(arg)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error(`no element: ${arg}`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    console.log('clicked', arg, 'at', Math.round(rect.x), Math.round(rect.y));
    c.close();
  } else if (step === 'probe-wb' || step === 'select' || step === 'chat-state' || step === 'send' || step === 'watch' || step === 'click-copy') {
    const target = await waitFor(
      () => findTarget((t) => t.url.includes('workbench.html')),
      20000,
      500,
      'workbench window',
    );
    const c = await attach(target);
    if (step === 'probe-wb') {
      console.log('url:', target.url);
      console.log(
        'cards:',
        await c.ev(`document.querySelectorAll('.ai00x-wbw__card').length`),
      );
      console.log(
        'chat panel:',
        await c.ev(`Boolean(document.querySelector('.ai00-x-workbench-chat'))`),
      );
      console.log(
        'chat head:',
        await c.ev(`document.querySelector('.ai00-x-workbench-chat')?.textContent?.slice(0, 200) ?? null`),
      );
      console.log(
        'composer nodes:',
        await c.ev(`(() => { const p = document.querySelector('.ai00-x-workbench-chat'); if (!p) return null; return JSON.stringify([...p.querySelectorAll('textarea,button')].map(e => e.tagName + ':' + (e.getAttribute('aria-label') || e.textContent.trim()).slice(0,30))); })()`),
      );
    } else if (step === 'select') {
      console.log(
        await c.ev(`(() => {
          const el = document.querySelector('.ai00x-wbw__preview[data-action="select"]');
          if (!el) return 'no preview card';
          el.click();
          return 'clicked ' + el.dataset.id;
        })()`),
      );
    } else if (step === 'chat-state') {
      console.log(
        await c.ev(`(() => {
          const p = document.querySelector('.ai00-x-workbench-chat');
          if (!p) return 'no chat panel';
          return JSON.stringify({
            head: p.querySelector('.ai00-x-workbench-chat__head')?.textContent?.trim(),
            project: p.querySelector('.ai00-x-workbench-chat__project')?.textContent,
            empty: p.querySelector('.ai00-x-workbench-chat__empty')?.textContent?.trim() ?? null,
            messages: p.querySelectorAll('.ai00-x-dsh-scene__messages > *').length,
            violations: [...p.querySelectorAll('.ai00-x-workbench-chat__violation')].map(v => v.textContent.trim()),
            binding: localStorage.getItem('ai00-x.workbench-sessions.v1'),
          });
        })()`),
      );
    } else if (step === 'send') {
      console.log(
        await c.ev(`(() => {
          const p = document.querySelector('.ai00-x-workbench-chat');
          if (!p) return 'no chat panel';
          const ta = p.querySelector('textarea');
          if (!ta) return 'no textarea';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${JSON.stringify(arg)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
          return 'typed';
        })()`),
      );
      await sleep(400);
      console.log(
        await c.ev(`(() => {
          const p = document.querySelector('.ai00-x-workbench-chat');
          const btns = [...p.querySelectorAll('button')];
          const info = btns.map(b => (b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 24) + (b.disabled ? '[disabled]' : ''));
          const hit = btns.find(b => !b.disabled && /send|发送|submit|排队|queue/i.test((b.getAttribute('aria-label') || '') + b.textContent));
          if (hit) { hit.click(); return 'clicked: ' + info.join(' | '); }
          return 'no send button; buttons: ' + info.join(' | ');
        })()`),
      );
    } else if (step === 'click-copy') {
      // 用真实鼠标事件（CDP Input）点击第一条助手消息的复制按钮，
      // 复刻用户手势：JS 合成 click 不产生用户激活，剪贴板 API 会拒绝。
      const rect = await c.ev(`(() => {
        const btn = document.querySelector('.ai00-x-dsh-scene__msg-copy');
        if (!btn) return null;
        btn.scrollIntoView({ block: 'center' });
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!rect) {
        console.log('no copy button');
      } else {
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: rect.x,
          y: rect.y,
        });
        await sleep(250);
        console.log(
          'hover opacity:',
          await c.ev(`(() => {
            const btn = document.querySelector('.ai00-x-dsh-scene__msg-copy');
            const wrap = btn.closest('.ai00-x-dsh-scene__msg-actions');
            return getComputedStyle(wrap).opacity;
          })()`),
        );
        for (const type of ['mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', {
            type,
            x: rect.x,
            y: rect.y,
            button: 'left',
            clickCount: 1,
          });
        }
        await sleep(300);
        console.log(
          await c.ev(`(() => {
            const btn = document.querySelector('.ai00-x-dsh-scene__msg-copy');
            return JSON.stringify({ label: btn.getAttribute('aria-label'), text: btn.textContent.trim() });
          })()`),
        );
      }
    } else if (step === 'watch') {
      const secs = Number(arg) || 60;
      const t0 = Date.now();
      let last = '';
      while (Date.now() - t0 < secs * 1000) {
        const snap = await c.ev(`(() => {
          const p = document.querySelector('.ai00-x-workbench-chat');
          if (!p) return null;
          return JSON.stringify({
            msgs: p.querySelectorAll('.ai00-x-dsh-scene__messages > *').length,
            violations: p.querySelectorAll('.ai00-x-workbench-chat__violation').length,
            tail: p.querySelector('.ai00-x-dsh-scene__messages')?.textContent?.slice(-300),
          });
        })()`);
        if (snap && snap !== last) {
          last = snap;
          console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, snap);
        }
        await sleep(2000);
      }
    }
    c.close();
  } else {
    console.log('unknown step');
    process.exit(1);
  }
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
