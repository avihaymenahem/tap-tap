/* Throwaway: crop a region out of an image (any format Chrome decodes) and
 * write it as a PNG, optionally magnified. node scripts/crop.mjs in.png out.png x y w h [scale] */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';

const [inp, outp, X, Y, Wd, Ht, SC = '1'] = process.argv.slice(2);
const PORT = 9642;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));
const PROFILE = resolve(`${tmpdir()}/crop-profile-${PORT}`);
await rm(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });
let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null; } catch {}
  if (!wsUrl) await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
const buf = await readFile(resolve(inp));
const mime = extname(inp).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
await send('Runtime.evaluate', { expression: `window.__u=${JSON.stringify(`data:${mime};base64,${buf.toString('base64')}`)};1`, returnByValue: true });
const r = await send('Runtime.evaluate', {
  expression: `(async()=>{const img=new Image();await new Promise((ok,e)=>{img.onload=ok;img.onerror=e;img.src=window.__u});
  const s=${Number(SC)};const c=document.createElement('canvas');c.width=${Number(Wd)}*s;c.height=${Number(Ht)}*s;
  const x=c.getContext('2d');x.imageSmoothingEnabled=false;
  x.drawImage(img,${Number(X)},${Number(Y)},${Number(Wd)},${Number(Ht)},0,0,c.width,c.height);
  return c.toDataURL('image/png').slice(22);})()`,
  returnByValue: true, awaitPromise: true,
});
await writeFile(resolve(outp), Buffer.from(r.result.value, 'base64'));
console.log('wrote', outp);
try { chrome.kill('SIGKILL'); } catch {}
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
process.exit(0);
