#!/usr/bin/env node
// 把 dsh-kanban 安装进 DSH 桌面版 profile。
//
// 为什么需要这个脚本：`dsh plugin --profile desktop add` 会被 CLI 拒绝
// （desktop profile 由 Electron 应用独占管理），因此这里按应用自己的布局
// 做同样三件事：profile package.json 加 link 依赖、bundles 追加包名、
// node_modules 建符号链接。改动前自动备份 package.json。
//
// 用法：
//   node scripts/install-desktop.mjs            # 安装到默认 desktop profile
//   node scripts/install-desktop.mjs --dry-run  # 只打印将要做的改动
//   node scripts/install-desktop.mjs --remove   # 移除
import { readFile, writeFile, mkdir, symlink, unlink, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-kanban';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const remove = args.has('--remove');
const profileName = process.env.DSH_KANBAN_PROFILE || 'desktop';
const profileDir = join(homedir(), '.dsh', 'profiles', profileName);
const manifestPath = join(profileDir, 'package.json');

function fail(message) {
  console.error('错误：' + message);
  process.exit(1);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const bundles = manifest?.dsh?.profile?.bundles;
const dependencies = manifest.dependencies ?? (manifest.dependencies = {});
if (!Array.isArray(bundles)) fail(`${manifestPath} 里没有 dsh.profile.bundles，无法安全修改。`);

const next = structuredClone(manifest);
const nextBundles = next.dsh.profile.bundles;
const currentIndex = nextBundles.indexOf(PACKAGE_NAME);
const dependencyValue = `link:${repoRoot}`;

if (remove) {
  nextBundles.splice(0, nextBundles.length, ...nextBundles.filter((name) => name !== PACKAGE_NAME));
  delete next.dependencies[PACKAGE_NAME];
} else {
  next.dependencies[PACKAGE_NAME] = dependencyValue;
  if (currentIndex === -1) nextBundles.push(PACKAGE_NAME);
}

const changes = [];
if (JSON.stringify(manifest) !== JSON.stringify(next)) changes.push(manifestPath);
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
const linkExists = await exists(linkPath);
if (remove ? linkExists : !linkExists) changes.push(linkPath);

if (dryRun) {
  console.log(JSON.stringify({ profileDir, repoRoot, remove, changes, next }, null, 2));
  process.exit(0);
}
if (!changes.length) {
  console.log(`已是最新状态：${PACKAGE_NAME} ${remove ? '不在' : '已在'} ${profileName} profile。`);
  process.exit(0);
}

if (!remove) {
  const backup = `${manifestPath}.bak-dsh-kanban`;
  if (!(await exists(backup))) await writeFile(backup, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  if (linkExists) await unlink(linkPath).catch(() => {});
  await symlink(repoRoot, linkPath);
}
await writeFile(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

console.log(`${remove ? '已移除' : '已安装'} ${PACKAGE_NAME} → ${profileName} profile`);
console.log('  profile: ' + profileDir);
console.log('  插件目录: ' + repoRoot);
console.log(remove ? '' : '  重启 DSH 后生效（侧栏出现「看板」入口）。');
