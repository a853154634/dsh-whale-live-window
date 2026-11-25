/**
 * 原生窗口联调探针（开发机手动跑）。
 * 真的把窗口拉起来，走 ready → state → close，然后退出。
 *
 *   node scripts/window-probe.mjs [窗口程序路径]
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.argv[2] ?? fileURLToPath(new URL('../bin/daozai.exe', import.meta.url));
const dataDir = process.env.DAOZAI_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'lw-probe-'));
console.log('executable:', executable);
console.log('data dir  :', dataDir);

const proc = spawn(executable, ['--whale-live-window', '--theme=dark,8DA6FF,202A43,EDF2FF'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DAOZAI_DATA_DIR: dataDir },
});

let buffer = '';
const seen = new Set();
const deadline = setTimeout(() => {
  console.error('timed out; saw:', [...seen].join(', ') || '(none)');
  proc.kill();
  process.exitCode = 1;
}, 30000);

proc.stdout.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    seen.add(message.type);
    console.log('<-', message.type);
    if (message.type === 'ready') {
      proc.stdin.write(JSON.stringify({
        type: 'state', activeId: 'probe', thinkingCount: 0, waitingCount: 0,
        idleBalance: '余额 ¥1.00', completionSequence: 0,
        sessions: [{
          id: 'probe', title: '探针会话', model: 'probe-model', provider: 'probe',
          modelLabel: 'Probe', usage: '暂无用量', quota: '', responseDuration: '1.2 秒',
          responseTime: '12:00', replyPreview: '这是一条来自探针的回复预览。',
          replyPreviewTruncated: false, pinned: false, thinking: false, waiting: false,
          status: 'completed', interaction: null,
        }],
        prefs: {
          autoCollapse: true, reducedMotion: false, showDetails: true, topPosition: 0,
          topDisplay: '', shape: 'pill', collapsedDisplay: 'amount',
          completionSound: false, completionFlash: true, sharedDrafts: false,
        },
        theme: { scheme: 'dark', accent: '8DA6FF', surface: '202A43', foreground: 'EDF2FF' },
      }) + '\n');
      console.log('-> state pushed');
      setTimeout(() => {
        proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
        proc.stdin.end();
        setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
      }, 1200);
    }
  }
});
proc.stderr.setEncoding('utf8').on('data', (c) => console.log('stderr:', c.trim().slice(0, 200)));
proc.on('exit', (code, signal) => {
  clearTimeout(deadline);
  console.log('window exited:', code ?? signal);
  if (seen.has('ready')) console.log('\nprobe passed: ready handshake + state accepted');
  else { console.error('\nprobe failed: no ready handshake'); process.exitCode = 1; }
});
