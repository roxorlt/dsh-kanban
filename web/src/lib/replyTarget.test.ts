import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_REPLY_TARGET,
  nextTargetAfterPrimaryChange,
  replyTargetOptions,
  resolveReplyTarget,
} from './replyTarget';
import type { SessionRow } from '../types';

const session = (id: string, title: string, running = false): SessionRow => ({
  id,
  title,
  running,
  updatedAt: 0,
});

describe('replyTargetOptions', () => {
  it('按绑定顺序（主会话在前）生成选项，并标记运行中', () => {
    const options = replyTargetOptions(
      ['s-1', 's-2'],
      [session('s-2', '执行会话', true), session('s-1', '讨论会话')],
    );
    expect(options).toEqual([
      { id: 's-1', title: '讨论会话', running: false, primary: true },
      { id: 's-2', title: '执行会话', running: true, primary: false },
    ]);
  });

  it('宿主会话列表缺少该会话时退回用 id 展示，不丢选项', () => {
    const options = replyTargetOptions(['s-1', 's-missing'], [session('s-1', '讨论会话')]);
    expect(options.at(1)).toEqual({ id: 's-missing', title: 's-missing', running: false, primary: false });
  });

  it('空标题同样退回 id', () => {
    const options = replyTargetOptions(['s-1'], [session('s-1', '   ')]);
    expect(options.at(0)?.title).toBe('s-1');
  });

  it('外部 Agent 跟进时把云端同步目标置顶，历史本地 DSH 会话不标主会话', () => {
    const options = replyTargetOptions(
      ['s-1'],
      [session('s-1', '旧本地会话', true)],
      { label: 'Carbon · Gemini（云端看板同步）' },
    );
    expect(options).toEqual([
      { id: EXTERNAL_REPLY_TARGET, title: 'Carbon · Gemini（云端看板同步）', running: false, primary: false },
      { id: 's-1', title: '旧本地会话', running: true, primary: false },
    ]);
  });
});

describe('resolveReplyTarget', () => {
  it('当前目标仍绑定则保留', () => {
    expect(resolveReplyTarget(['s-1', 's-2'], 's-2')).toBe('s-2');
  });

  it('当前目标已解绑/切卡时回退主会话', () => {
    expect(resolveReplyTarget(['s-1', 's-2'], 's-gone')).toBe('s-1');
    expect(resolveReplyTarget(['s-1'], null)).toBe('s-1');
  });

  it('无绑定会话返回 null', () => {
    expect(resolveReplyTarget([], 's-1')).toBeNull();
  });

  it('外部 Agent 跟进卡片默认回到 EXTERNAL_REPLY_TARGET，显式选历史会话时保留', () => {
    expect(resolveReplyTarget([], null, true)).toBe(EXTERNAL_REPLY_TARGET);
    expect(resolveReplyTarget(['s-1', 's-2'], null, true)).toBe(EXTERNAL_REPLY_TARGET);
    expect(resolveReplyTarget(['s-1', 's-2'], 's-gone', true)).toBe(EXTERNAL_REPLY_TARGET);
    expect(resolveReplyTarget(['s-1', 's-2'], 's-2', true)).toBe('s-2');
    expect(resolveReplyTarget(['s-1', 's-2'], EXTERNAL_REPLY_TARGET, true)).toBe(EXTERNAL_REPLY_TARGET);
  });
});

describe('nextTargetAfterPrimaryChange', () => {
  it('目标就是旧主会话时跟随到新主会话', () => {
    expect(nextTargetAfterPrimaryChange('s-1', 's-1', 's-2')).toBe('s-2');
    expect(nextTargetAfterPrimaryChange(EXTERNAL_REPLY_TARGET, EXTERNAL_REPLY_TARGET, 's-1')).toBe('s-1');
  });

  it('还没选过目标时默认到新主会话', () => {
    expect(nextTargetAfterPrimaryChange(null, 's-1', 's-2')).toBe('s-2');
  });

  it('用户手动选过其它会话则保持不变', () => {
    expect(nextTargetAfterPrimaryChange('s-3', 's-1', 's-2')).toBe('s-3');
  });

  it('没有新主会话时保持原目标', () => {
    expect(nextTargetAfterPrimaryChange('s-2', 's-1', null)).toBe('s-2');
    expect(nextTargetAfterPrimaryChange(null, 's-1', null)).toBeNull();
  });
});
