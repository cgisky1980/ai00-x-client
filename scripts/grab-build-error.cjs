// 一次性调试脚本：抓 vite build 完整错误输出（用后即删）
const { execSync } = require('node:child_process');
try {
  execSync('npx vite build', {
    cwd: 'C:/work/ai00-x-dev/client/src/web-ui',
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 50,
  });
  console.log('BUILD OK');
} catch (e) {
  const s = (e.stdout || '') + '\n===STDERR===\n' + (e.stderr || '');
  const lines = s.split('\n').filter((l) => /Error|error|\.scss|expected|Undefined|\|/i.test(l));
  console.log(lines.slice(0, 25).join('\n') || s.slice(-3000));
}
