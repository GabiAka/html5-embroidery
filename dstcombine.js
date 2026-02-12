import fs from "fs";
import path from "path";

/* =========================
 * CONSTANTS
 * ========================= */
const DST_HEADER_SIZE = 512;
const DST_END = [0x00, 0x00, 0xf3];
const MAX_DELTA = 121;

/* =========================
 * DST ENCODE (jump only)
 * ========================= */
function encodeDstDelta(dx, dy) {
  let b0 = 0,
    b1 = 0,
    b2 = 0;

  const enc = (v, pos, neg) => (v > 0 ? pos : v < 0 ? neg : 0);

  // X
  if (Math.abs(dx) >= 81) {
    b2 |= enc(dx, 0x04, 0x08);
    dx -= Math.sign(dx) * 81;
  }
  if (Math.abs(dx) >= 27) {
    b1 |= enc(dx, 0x04, 0x08);
    dx -= Math.sign(dx) * 27;
  }
  if (Math.abs(dx) >= 9) {
    b0 |= enc(dx, 0x04, 0x08);
    dx -= Math.sign(dx) * 9;
  }
  if (Math.abs(dx) >= 3) {
    b1 |= enc(dx, 0x01, 0x02);
    dx -= Math.sign(dx) * 3;
  }
  if (Math.abs(dx) >= 1) {
    b0 |= enc(dx, 0x01, 0x02);
  }

  // Y
  if (Math.abs(dy) >= 81) {
    b2 |= enc(dy, 0x20, 0x10);
    dy -= Math.sign(dy) * 81;
  }
  if (Math.abs(dy) >= 27) {
    b1 |= enc(dy, 0x20, 0x10);
    dy -= Math.sign(dy) * 27;
  }
  if (Math.abs(dy) >= 9) {
    b0 |= enc(dy, 0x20, 0x10);
    dy -= Math.sign(dy) * 9;
  }
  if (Math.abs(dy) >= 3) {
    b1 |= enc(dy, 0x80, 0x40);
    dy -= Math.sign(dy) * 3;
  }
  if (Math.abs(dy) >= 1) {
    b0 |= enc(dy, 0x80, 0x40);
  }

  // jump flag
  b2 |= 0x83;

  return [b0, b1, b2];
}

/* =========================
 * CALC END POSITION
 * ========================= */
function getEndPosition(dst) {
  let x = 0;
  let y = 0;

  let i = DST_HEADER_SIZE;
  while (!(dst[i] === 0x00 && dst[i + 1] === 0x00 && dst[i + 2] === 0xf3)) {
    const b0 = dst[i];
    const b1 = dst[i + 1];
    const b2 = dst[i + 2];

    let dx = 0;
    let dy = 0;

    const dec = (b, pos, neg, val) => {
      if (b & pos) return val;
      if (b & neg) return -val;
      return 0;
    };

    // X
    dx += dec(b2, 0x04, 0x08, 81);
    dx += dec(b1, 0x04, 0x08, 27);
    dx += dec(b0, 0x04, 0x08, 9);
    dx += dec(b1, 0x01, 0x02, 3);
    dx += dec(b0, 0x01, 0x02, 1);

    // Y
    dy += dec(b2, 0x20, 0x10, 81);
    dy += dec(b1, 0x20, 0x10, 27);
    dy += dec(b0, 0x20, 0x10, 9);
    dy += dec(b1, 0x80, 0x40, 3);
    dy += dec(b0, 0x80, 0x40, 1);

    x += dx;
    y += dy;

    i += 3;
  }

  return { x, y };
}

/* =========================
 * SPLIT LARGE JUMP
 * ========================= */
function splitJump(dx, dy) {
  const res = [];
  while (dx !== 0 || dy !== 0) {
    const sx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
    const sy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
    res.push(encodeDstDelta(sx, sy));
    dx -= sx;
    dy -= sy;
  }
  return res;
}

/* =========================
 * COPY STITCHES (no END)
 * ========================= */
function copyStitchesWithoutEnd(dst, out) {
  let i = DST_HEADER_SIZE;
  while (!(dst[i] === 0x00 && dst[i + 1] === 0x00 && dst[i + 2] === 0xf3)) {
    out.push(dst[i], dst[i + 1], dst[i + 2]);
    i += 3;
  }
}

/* =========================
 * COMBINE DST
 * ========================= */
function combineDst(dst1, dst2, offsetX = 0, offsetY = 0) {
  const out = [];

  // header từ file 1
  out.push(...dst1.slice(0, DST_HEADER_SIZE));

  // stitches file 1
  copyStitchesWithoutEnd(dst1, out);

  // jump offset
  if (offsetX !== 0 || offsetY !== 0) {
    const jumps = splitJump(offsetX, offsetY);
    jumps.forEach((j) => out.push(...j));
  }

  // stitches file 2
  copyStitchesWithoutEnd(dst2, out);

  // END
  out.push(...DST_END);

  return new Uint8Array(out);
}

/* =========================
 * COMBINE DST KEEP COLOR
 * ========================= */
const DST_COLOR_CHANGE = [0x00, 0x00, 0xc3];

function combineDstKeepColor(dst1, dst2) {
  const out = [];

  // header lấy từ file 1
  out.push(...dst1.slice(0, DST_HEADER_SIZE));

  // --- FILE 1 ---
  copyStitchesWithoutEnd(dst1, out);

  // 🔥 tính vị trí kết thúc file 1
  const { x, y } = getEndPosition(dst1);

  // 🔥 jump về (0,0)
  if (x !== 0 || y !== 0) {
    const jumps = splitJump(-x, -y);
    jumps.forEach((j) => out.push(...j));
  }

  // 🔥 đổi màu trước khi vẽ file 2
  out.push(...DST_COLOR_CHANGE);

  // --- FILE 2 ---
  copyStitchesWithoutEnd(dst2, out);

  // END
  out.push(...DST_END);

  return new Uint8Array(out);
}

/* =========================
 * MAIN
 * ========================= */
const assetsDir = path.resolve("./assets");

const file1 = fs.readFileSync(path.join(assetsDir, "CircleNoFill.dst"));
const file2 = fs.readFileSync(path.join(assetsDir, "SquareNoFill.dst"));

const dst1 = new Uint8Array(file1);
const dst2 = new Uint8Array(file2);

// offset cho file thứ 2 (đổi theo nhu cầu)
// const merged = combineDst(dst1, dst2, 0, 0);
const merged = combineDstKeepColor(dst1, dst2);

// save
fs.writeFileSync(path.join(assetsDir, "merged.dst"), Buffer.from(merged));

console.log("✅ merged.dst created successfully");
