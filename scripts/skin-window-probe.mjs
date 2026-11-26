/**
 * 配色皮肤的原生窗口联调探针（开发机手动跑）。
 *
 * 真的把窗口拉起来，按不同的皮肤发不同的主题，看窗口有没有换色。
 *
 *   node scripts/skin-window-probe.mjs [窗口程序路径]
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkinTheme } from '../lib/host/skins.js';

const executable = process.env.WHALE_WINDOW ?? fileURLToPath(new URL('../bin/daozai.exe', import.meta.url));
const dataDir = process.env.DAOZAI_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'lw-skin-'));
console.log('executable:', executable);
console.log('data dir  :', dataDir);

const state = (theme) => JSON.stringify({
  type: 'state', activeId: 'probe', thinkingCount: 0, waitingCount: 0,
  idleBalance: '', completionSequence: 0, draft: null,
  prefs: {
    autoCollapse: true, reducedMotion: false, showDetails: true, topPosition: 0,
    topDisplay: '', shape: 'pill', collapsedDisplay: 'amount',
    completionSound: false, completionFlash: true, sharedDrafts: false,
  },
  theme,
  sessions: [{
    id: 'probe', title: '探针会话', model: 'probe-model', provider: 'probe',
    modelLabel: 'Probe', usage: '暂无用量', quota: '', responseDuration: '1.2 秒',
    responseTime: '12:00', replyPreview: '这是一条来自探针的回复预览。',
    replyPreviewTruncated: false, pinned: false, thinking: false, waiting: false,
    status: 'completed', interaction: null,
  }],
}) + '\n';

/** 每种皮肤要用的配色（明暗跟随 DSH 的深色）。 */
const base = { scheme: 'dark', accent: '8DA6FF', surface: '202A43', foreground: 'EDF2FF' };
const allSkins = ['follow', 'classic', 'cream', 'glass_light', 'glass_dark'];
/* 可以只跑一种皮肤：`node scripts/skin-window-probe.mjs cream`。
 * 联调时常用这个办法：一次只开一个窗口，截图不会被上一个窗口盖住。
 * 第二个参数可以覆盖强调色，方便在截图里一眼认出是哪个窗口：
 * `node scripts/skin-window-probe.mjs cream FF00FF`。 */
const args = process.argv.slice(2);
const requested = args.filter((arg) => allSkins.includes(arg));
const skins = requested.length ? requested : allSkins;
const accentOverride = args.find((arg) => /^[\dA-Fa-f]{6}$/.test(arg));
const surfaceOverride = args.find((arg) => /^surface:[\dA-Fa-f]{6}$/.test(arg))?.slice('surface:'.length);

const proc = spawn(executable, ['--whale-live-window', '--theme=dark,8DA6FF,202A43,EDF2FF'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DAOZAI_DATA_DIR: dataDir },
});

let buffer = '';
let ready = false;
const deadline = setTimeout(() => {
  console.error('timed out; ready =', ready);
  proc.kill();
  process.exitCode = 1;
}, 60000);

proc.stdout.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type !== 'ready' || ready) continue;
    ready = true;
    let index2 = 0;
    const step = () => {
      if (index2 >= skins.length) {
        proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
        proc.stdin.end();
        setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 800);
        return;
      }
      const skin = skins[index2++];
      const theme = resolveSkinTheme(skin, 'follow', base);
      if (accentOverride) theme.accent = accentOverride.toUpperCase();
      if (surfaceOverride) theme.surface = surfaceOverride.toUpperCase();
      console.log(`skin=${skin} -> ${theme.scheme} accent=${theme.accent} surface=${theme.surface} fg=${theme.foreground}`);
      proc.stdin.write(state(theme));
      /* 每种皮肤留 6 秒，给窗口重绘与截图留时间。
       * 只跑一种皮肤时留 30 秒：截图通常在脚本启动几秒后才拍。 */
      const hold = skins.length === 1 ? 30000 : 6000;
      setTimeout(step, hold);
    };
    step();
  }
});
proc.stderr.setEncoding('utf8').on('data', (c) => console.log('stderr:', c.trim().slice(0, 200)));
proc.on('exit', (code, signal) => {
  clearTimeout(deadline);
  console.log('window exited:', code ?? signal);
  if (ready) console.log('\nprobe passed: every skin was pushed to the live window');
  else { console.error('\nprobe failed: no ready handshake'); process.exitCode = 1; }
});
