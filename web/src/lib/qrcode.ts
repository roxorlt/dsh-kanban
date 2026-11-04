/**
 * 零外部依赖的 ISO/IEC 18004 标准二维码矩阵编码器（Byte 模式，ECC Level L，支持 Version 1–10，最高 271 UTF-8 字节）。
 * 专为在看板弹窗本地离线渲染腾讯 iLink 微信扫码链接（`https://liteapp.weixin.qq.com/q/...`，约 89 字节）设计：
 * - 不发起任何第三方图片 API 请求，不泄露登录二维码链接，不受 CSP 限制；
 * - 生成合并水平相邻模块的紧凑 SVG `<path>`，在高清屏与亮/暗主题下均边缘锐利。
 */

interface VersionSpec {
  version: number;
  totalData: number;
  ecPerBlock: number;
  blocks: readonly number[];
  align: readonly number[];
}

const VERSION_SPECS_L: readonly VersionSpec[] = [
  { version: 1, totalData: 19, ecPerBlock: 7, blocks: [19], align: [] },
  { version: 2, totalData: 34, ecPerBlock: 10, blocks: [34], align: [6, 18] },
  { version: 3, totalData: 55, ecPerBlock: 15, blocks: [55], align: [6, 22] },
  { version: 4, totalData: 80, ecPerBlock: 20, blocks: [80], align: [6, 26] },
  { version: 5, totalData: 108, ecPerBlock: 26, blocks: [108], align: [6, 30] },
  { version: 6, totalData: 136, ecPerBlock: 18, blocks: [68, 68], align: [6, 34] },
  { version: 7, totalData: 156, ecPerBlock: 20, blocks: [78, 78], align: [6, 22, 38] },
  { version: 8, totalData: 194, ecPerBlock: 24, blocks: [97, 97], align: [6, 24, 42] },
  { version: 9, totalData: 232, ecPerBlock: 30, blocks: [116, 116], align: [6, 26, 46] },
  { version: 10, totalData: 274, ecPerBlock: 18, blocks: [68, 68, 69, 69], align: [6, 28, 50] },
];

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < degree) {
        result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result.copyWithin(0, 1);
    result[divisor.length - 1] = 0;
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

function appendBits(val: number, len: number, out: number[]): void {
  for (let i = len - 1; i >= 0; i -= 1) {
    out.push((val >>> i) & 1);
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function computePenalty(modules: boolean[][], size: number): number {
  let score = 0;

  // 规则 1：同行/同列连续 5 个及以上同色模块
  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y]?.[0] ?? false;
    let runLen = 1;
    for (let x = 1; x < size; x += 1) {
      const c = modules[y]?.[x] ?? false;
      if (c === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = c;
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0]?.[x] ?? false;
    let runLen = 1;
    for (let y = 1; y < size; y += 1) {
      const c = modules[y]?.[x] ?? false;
      if (c === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = c;
        runLen = 1;
      }
    }
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y]?.[x] ?? false;
      if (
        c === (modules[y]?.[x + 1] ?? false) &&
        c === (modules[y + 1]?.[x] ?? false) &&
        c === (modules[y + 1]?.[x + 1] ?? false)
      ) {
        score += 3;
      }
    }
  }

  // 规则 4：深浅模块比例均衡度
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y]?.[x]) dark += 1;
    }
  }
  const total = size * size;
  const k = Math.ceil((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
  score += Math.max(0, k) * 10;

  return score;
}

export interface QrMatrix {
  version: number;
  size: number;
  modules: boolean[][];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSION_SPECS_L.find((entry) => {
    const countBits = entry.version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + bytes.length * 8;
    return neededBits <= entry.totalData * 8;
  });

  if (!spec) {
    throw new Error(`二维码内容过长（${bytes.length} 字节，当前支持上限 271 字节）`);
  }

  const countBits = spec.version <= 9 ? 8 : 16;
  const dataCapacityBits = spec.totalData * 8;
  const bits: number[] = [];

  // Mode indicator: Byte = 0100
  appendBits(0b0100, 4, bits);
  appendBits(bytes.length, countBits, bits);
  for (const b of bytes) {
    appendBits(b, 8, bits);
  }
  // Terminator (up to 4 zero bits)
  appendBits(0, Math.min(4, dataCapacityBits - bits.length), bits);
  // Pad to byte boundary
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);
  // Pad codewords 0xEC, 0x11
  let padToggle = 0;
  while (bits.length < dataCapacityBits) {
    appendBits(padToggle === 0 ? 0xec : 0x11, 8, bits);
    padToggle ^= 1;
  }

  const dataCodewords = new Uint8Array(spec.totalData);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) {
      const idx = i >>> 3;
      dataCodewords[idx] = (dataCodewords[idx] ?? 0) | (1 << (7 - (i & 7)));
    }
  }

  // 分块计算 Reed-Solomon 纠错码并按列交织
  const rsDiv = reedSolomonDivisor(spec.ecPerBlock);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const blockLen of spec.blocks) {
    const chunk = dataCodewords.subarray(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(chunk);
    ecBlocks.push(reedSolomonRemainder(chunk, rsDiv));
  }

  const maxDataLen = Math.max(...spec.blocks);
  const interleaved: number[] = [];
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i] ?? 0);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      if (i < block.length) interleaved.push(block[i] ?? 0);
    }
  }

  const size = 17 + spec.version * 4;
  const baseModules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  const setFunc = (x: number, y: number, dark: boolean) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    baseModules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  // Timing patterns
  for (let i = 0; i < size; i += 1) {
    const dark = i % 2 === 0;
    setFunc(6, i, dark);
    setFunc(i, 6, dark);
  }

  // Finder patterns + separators (top-left, top-right, bottom-left)
  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns
  const align = spec.align;
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) {
        continue;
      }
      const cx = align[i]!;
      const cy = align[j]!;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunc(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format info & dark module
  const drawFormatBits = (target: boolean[][], markFunc: boolean, mask: number) => {
    const data = (0b01 << 3) | mask; // ECC Level L = 01
    let rem = data;
    for (let i = 0; i < 10; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const fmt = ((data << 10) | rem) ^ 0x5412;
    const put = (x: number, y: number, bitIdx: number) => {
      const dark = ((fmt >>> bitIdx) & 1) !== 0;
      target[y]![x] = dark;
      if (markFunc) isFunction[y]![x] = true;
    };

    for (let i = 0; i <= 5; i += 1) put(8, i, i);
    put(8, 7, 6);
    put(8, 8, 7);
    put(7, 8, 8);
    for (let i = 9; i < 15; i += 1) put(14 - i, 8, i);

    for (let i = 0; i < 8; i += 1) put(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i += 1) put(8, size - 15 + i, i);

    target[size - 8]![8] = true;
    if (markFunc) isFunction[size - 8]![8] = true;
  };
  drawFormatBits(baseModules, true, 0);

  // Version info (Version >= 7)
  if (spec.version >= 7) {
    let rem = spec.version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const vbits = (spec.version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vbits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // Zigzag data placement
  let bitIdx = 0;
  const totalBits = interleaved.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIdx < totalBits) {
          const byteVal = interleaved[bitIdx >>> 3] ?? 0;
          baseModules[y]![x] = ((byteVal >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx += 1;
        }
      }
    }
  }

  // 选择惩罚分最低的掩码（0..7）
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestModules = baseModules;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = baseModules.map((row, y) =>
      row.map((val, x) => (!isFunction[y]![x] && maskBit(mask, x, y) ? !val : val)),
    );
    drawFormatBits(candidate, false, mask);
    const score = computePenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;

  return {
    version: spec.version,
    size,
    modules: bestModules,
  };
}

/**
 * 将二维码矩阵编码为 SVG `<path d="...">` 与 `viewBox`（自带 2 模块静区）。
 */
export function buildQrSvgPath(text: string, margin = 2): { viewBox: string; path: string; size: number } {
  const { size, modules } = encodeQrMatrix(text);
  const full = size + margin * 2;
  const parts: string[] = [];

  for (let y = 0; y < size; y += 1) {
    const row = modules[y]!;
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x += 1;
      const w = x - start;
      parts.push(`M${start + margin} ${y + margin}h${w}v1h-${w}z`);
    }
  }

  return {
    viewBox: `0 0 ${full} ${full}`,
    path: parts.join(''),
    size: full,
  };
}
