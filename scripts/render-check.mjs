/**
 * 渲染自检：用 Vite 的 SSR 模块加载器真实执行一次 React 组件树，
 * 确认没有"一打开就白屏"级别的渲染期异常（无需浏览器）。
 * 用法：node scripts/render-check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const EXPECTED = ['凡尘·需求台', '任务清单', '设置', '发送'];

let server;
try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  });

  const { default: App } = await server.ssrLoadModule('/src/App.tsx');
  const html = renderToString(createElement(App));

  const missing = EXPECTED.filter((token) => !html.includes(token));
  if (missing.length > 0) {
    console.error(`\u2716 渲染结果缺少关键文案：${missing.join('、')}`);
    process.exitCode = 1;
  } else {
    console.log(`\u2714 React 组件树渲染成功，输出 ${html.length} 字符，关键文案齐全`);
  }
} catch (err) {
  console.error('\u2716 渲染失败：', err?.stack ?? err);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
}
