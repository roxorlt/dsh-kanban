#!/usr/bin/env node
/**
 * 从 design/mockup.html 抽取 <style id="kanban-styles"> 组件样式，供 dsh-ui-spec lint 使用。
 * 不抽取 <style id="dsh-token-shadow">：那是单文件 mockup 的"主题替身"，
 * 真实 DSH 插件里由 ui-theme 注入，不属于组件样式。
 *
 * 用法：node design/lint/extract.mjs
 * 然后：node ~/.dsh/skills/dsh-ui-spec/scripts/lint-tokens.mjs design/lint
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, '..', 'mockup.html');
const outPath = path.join(here, 'mockup-component.module.css');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<style id="kanban-styles">([\s\S]*?)<\/style>/);
if (!match) {
  console.error('未找到 <style id="kanban-styles">');
  process.exit(1);
}
const header = '/* 自动抽取自 design/mockup.html 的 <style id="kanban-styles">，仅用于 lint，请勿手改。 */\n';
fs.writeFileSync(outPath, header + match[1].trim() + '\n');
console.log('wrote', path.relative(process.cwd(), outPath));
