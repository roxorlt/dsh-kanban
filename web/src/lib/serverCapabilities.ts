/**
 * 服务端能力探测：看板 Web（静态产物）与服务端（DSH 宿主内 `lib/`）可能版本错配。
 * 典型场景：DSH 宿主未重启 → 运行中的服务端仍是旧版本，但 iframe 已加载新前端产物。
 * 这里不依赖新增接口字段（旧服务端不会返回），改用 `/health` 的 `version` 做最低版本判断。
 */

/** 服务端开始支持多题审批「其他（自行填写）」答案（optionIds 可为空 + custom）的最低版本。 */
export const CUSTOM_ANSWER_MIN_SERVER_VERSION: readonly [number, number, number] = [0, 9, 5];

/**
 * 解析形如 `0.9.5` / `v0.9.5` / `0.10.0-rc.1` 的版本号。
 * @param version 服务端返回的版本字符串。
 * @returns 主/次/修订三段数字；无法解析时返回 null。
 */
export function parseServerVersion(version: string | null | undefined): [number, number, number] | null {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 比较两个三段版本号：a>b 返回 1，相等返回 0，a<b 返回 -1。 */
export function compareServerVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * 服务端是否支持多题审批的自定义回答。
 *
 * 规则：未知版本（尚未取到 / 解析失败）按「支持」处理，保持既有行为，
 * 避免独立预览或未来版本被误伤；只有拿到明确且低于最低版本的版本号时才降级。
 * @param version `/api/kanban/health` 返回的 version。
 * @returns 是否支持自定义回答。
 */
export function supportsApprovalCustomAnswers(version: string | null | undefined): boolean {
  const parsed = parseServerVersion(version);
  if (!parsed) return true;
  return compareServerVersions(parsed, CUSTOM_ANSWER_MIN_SERVER_VERSION) >= 0;
}
