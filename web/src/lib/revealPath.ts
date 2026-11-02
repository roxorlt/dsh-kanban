/**
 * 「在 Finder / 文件管理器中定位」的允许路径集合（契约 docs/contracts/03-client-bridge.md §8）。
 *
 * 权限边界：看板只允许在工作副本/仓库目录上调用宿主的本地定位能力。允许集合来自
 * 服务端 `/git/workspaces` 推导出的仓库根与工作副本路径（服务端只接受看板卡片 cwd
 * 推导出的仓库），前端按**精确路径**判定，不做前缀匹配——因此任意路径、命令串、
 * 子目录都不会通过。
 */

/** 允许集合的最小数据形状（WorkspaceRepoGroup 满足该形状）。 */
export interface RevealableRepoGroup {
  root: string;
  worktrees: readonly { path: string }[];
}

/** 收集允许在 Finder 中定位的路径：仓库根 + 每个工作副本路径。 */
export function collectRevealablePaths(
  repos: readonly RevealableRepoGroup[] | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  for (const repo of repos ?? []) {
    if (!repo) continue;
    if (typeof repo.root === 'string' && repo.root) paths.add(repo.root);
    const worktrees = Array.isArray(repo.worktrees) ? repo.worktrees : [];
    for (const worktree of worktrees) {
      if (worktree && typeof worktree.path === 'string' && worktree.path) paths.add(worktree.path);
    }
  }
  return paths;
}

/** 这条路径是否允许交给宿主定位：必须是允许集合里的精确路径。 */
export function isRevealablePath(path: string, allowed: ReadonlySet<string>): boolean {
  if (typeof path !== 'string' || path === '') return false;
  return allowed.has(path);
}
