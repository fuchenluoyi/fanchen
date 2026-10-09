/**
 * 并行启动前端（Vite）与后端（Node 代理）。
 * 不依赖 concurrently：直接用 node:child_process，stdio 继承父进程。
 * 用法：pnpm dev
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;
const apiPort = process.env.API_PORT ?? '8787';
const webPort = process.env.WEB_PORT ?? '5173';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function start(label, args) {
  const child = spawn(node, args, { cwd: root, stdio: 'inherit', env: process.env });
  child.on('error', (err) => {
    console.error(`[dev] 启动 ${label} 失败:`, err.message);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
  }
  setTimeout(() => process.exit(code), 150).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] 后端 http://127.0.0.1:' + apiPort);
console.log('[dev] 前端 http://127.0.0.1:' + webPort);

start('api', ['server/index.mjs', '--port', apiPort]);
start('web', ['node_modules/vite/bin/vite.js', '--port', webPort, '--strictPort']);
