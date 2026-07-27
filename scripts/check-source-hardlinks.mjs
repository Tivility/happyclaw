#!/usr/bin/env node
/**
 * 备份前的硬链接检查。
 *
 * 判据是「归档树内有 ≥2 个路径共享同一个 inode」，**不是**「文件 nlink > 1」。
 *
 * 两者不等价，而用后者会造成误拦：Claude Code 跑后台命令时会把
 * `/tmp/claude-501/.../tasks/xxx.output` 硬链接进会话的
 * `data/sessions/{folder}/.claude/projects/.../tool-results/xxx.txt`。
 * 这个文件 nlink=2，但另一端在 /tmp、永远不会进归档 —— tar 只会把它当普通
 * 文件存下来，没有任何风险。按 nlink 拦截的话，agent 在工作区里跑过一次后台
 * 命令就会让 `make backup` 永久失败，等于在最需要备份的时候没有备份。
 *
 * 只有同一个 inode 在树内出现两次，tar 才会为第 2 次出现写「链接到前面成员」
 * 的条目 —— 那才是需要人工确认的情况。
 *
 * 必须扫源目录而不是暂存副本：macOS 的 `cp -a` 不保留硬链接（GNU cp -a 才
 * 保留），副本里 nlink 已经降为 1，扫副本在 macOS 上恒不触发。
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , rootArg] = process.argv;
if (!rootArg) {
  console.error('Usage: node scripts/check-source-hardlinks.mjs <data-dir>');
  process.exit(2);
}

const root = path.resolve(rootArg);
/** @type {Map<string, string[]>} inode key -> 树内路径 */
const byInode = new Map();

function walk(current) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return; // 扫描期间目录被删（会话轮转）不算错误
  }
  for (const entry of entries) {
    const candidate = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue; // 符号链接由 prepare-backup-tree 负责
    if (entry.isDirectory()) {
      walk(candidate);
      continue;
    }
    if (!entry.isFile()) continue;
    let st;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (st.nlink < 2) continue; // nlink=1 不可能在树内出现第二次
    // dev 一并入键：不同卷上的 inode 号可以重复。
    const key = `${st.dev}:${st.ino}`;
    const paths = byInode.get(key);
    if (paths) paths.push(candidate);
    else byInode.set(key, [candidate]);
  }
}

if (!fs.existsSync(root)) process.exit(0);
walk(root);

const duplicates = [...byInode.values()].filter((paths) => paths.length > 1);
if (duplicates.length === 0) process.exit(0);

console.error(
  `❌ 运行时数据里有 ${duplicates.length} 组硬链接的两端都在归档树内，` +
    `tar 会把后出现的一端存成链接条目，恢复到其他机器上可能不完整。请先处理：`,
);
for (const paths of duplicates.slice(0, 10)) {
  console.error(`   同一 inode:`);
  for (const p of paths) console.error(`     ${path.relative(root, p)}`);
}
if (duplicates.length > 10) {
  console.error(`   ...还有 ${duplicates.length - 10} 组`);
}
process.exit(1);
