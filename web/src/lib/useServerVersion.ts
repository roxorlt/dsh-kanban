import { useEffect, useState } from 'react';
import { api } from '../api';

/** 整个页面周期只请求一次 `/health`；失败也缓存 null，避免每个审批面板重复打点。 */
let cachedVersion: Promise<string | null> | null = null;

/**
 * 读取服务端版本（模块级缓存）。
 * @returns 服务端 `/health.version`；请求失败时为 null。
 */
export function loadServerVersion(): Promise<string | null> {
  if (!cachedVersion) {
    cachedVersion = api
      .getHealth()
      .then((health) => (typeof health.version === 'string' ? health.version : null))
      .catch(() => null);
  }
  return cachedVersion;
}

/**
 * 订阅服务端版本：首帧返回 null（未知），取到后更新。
 * 未知状态由调用方按「能力可用」的乐观策略处理，避免闪一下禁用态。
 * @returns 服务端版本字符串，未知时 null。
 */
export function useServerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadServerVersion().then((resolved) => {
      if (active) setVersion(resolved);
    });
    return () => {
      active = false;
    };
  }, []);
  return version;
}
