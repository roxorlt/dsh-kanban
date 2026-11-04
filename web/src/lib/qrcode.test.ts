import { describe, expect, it } from 'vitest';
import { buildQrSvgPath, encodeQrMatrix } from './qrcode';

describe('qrcode encoder', () => {
  it('encodes real-length WeChat iLink login URLs into Version 5 matrix cleanly', () => {
    const url = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=6e4d5db8340ae04baf2083e2c2a8fbce&bot_type=3';
    const qr = encodeQrMatrix(url);
    expect(qr.version).toBe(5);
    expect(qr.size).toBe(37);
    // Finder corners must be dark
    expect(qr.modules[0]?.[0]).toBe(true);
    expect(qr.modules[0]?.[36]).toBe(true);
    expect(qr.modules[36]?.[0]).toBe(true);
    // Separator outside top-left finder must be light
    expect(qr.modules[7]?.[0]).toBe(false);
    expect(qr.modules[0]?.[7]).toBe(false);
    // Fixed dark module at (x=8, y=size-8)
    expect(qr.modules[37 - 8]?.[8]).toBe(true);
  });

  it('supports multi-block versions (Version 6-10) and builds compact SVG path', () => {
    const v8Url = `https://ilinkai.weixin.qq.com/login?payload=${'a'.repeat(140)}`;
    const svg = buildQrSvgPath(v8Url, 2);
    expect(svg.viewBox).toBe('0 0 53 53'); // Version 8: 49 + 4 = 53
    expect(svg.path.startsWith('M2 2h7v1h-7z')).toBe(true);

    const v9Url = `https://ilinkai.weixin.qq.com/login?payload=${'b'.repeat(180)}`;
    const svg9 = buildQrSvgPath(v9Url, 2);
    expect(svg9.viewBox).toBe('0 0 57 57'); // Version 9: 53 + 4 = 57
  });
});
