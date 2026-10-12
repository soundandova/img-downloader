"""
量化"webp 转 jpg 到底损失多少"。

方法：取一张真实下载的图（服务器原始字节），用 Pillow 转成不同质量的 JPEG，
      再解码回像素，和原始像素逐点比较，算 PSNR / SSIM / 最大误差。
      因为输入已经是"有损 webp"，所以任何再编码都是第二代损失。

用法：python tools/format-quality.py [图片路径]
"""
import io
import os
import sys
import glob

from PIL import Image
import numpy as np


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    if mse == 0:
        return float("inf")
    return 10 * np.log10(255.0 ** 2 / mse)


def ssim(a, b):
    """全局 SSIM（11x11 均值核，逐通道计算后取平均），够做相对比较"""
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    kernel = np.ones((11, 11), dtype=np.float64) / 121.0

    def blur(x):
        from numpy.fft import rfft2, irfft2
        sh, sw = x.shape
        kh, kw = kernel.shape
        ph, pw = sh + kh - 1, sw + kw - 1
        fx = rfft2(x, (ph, pw))
        fk = rfft2(kernel, (ph, pw))
        y = irfft2(fx * fk, (ph, pw))
        return y[kh - 1:kh - 1 + sh, kw - 1:kw - 1 + sw]

    def ssim_2d(x, y):
        x = x.astype(np.float64)
        y = y.astype(np.float64)
        mu_x, mu_y = blur(x), blur(y)
        vx = blur(x * x) - mu_x * mu_x
        vy = blur(y * y) - mu_y * mu_y
        cov = blur(x * y) - mu_x * mu_y
        s = ((2 * mu_x * mu_y + C1) * (2 * cov + C2)) / ((mu_x ** 2 + mu_y ** 2 + C1) * (vx + vy + C2))
        return float(s.mean())

    # a/b 可能是 (H,W) 灰度或 (H,W,3) 彩色
    if a.ndim == 2:
        return ssim_2d(a, b)
    return float(np.mean([ssim_2d(a[:, :, c], b[:, :, c]) for c in range(a.shape[2])]))


def setup_stdout():
    """Windows 控制台默认不是 UTF-8，中文会乱码"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def find_sample():
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        return sys.argv[1]
    dl = os.path.join(os.path.expanduser("~"), "Downloads")
    for d in os.listdir(dl) if os.path.isdir(dl) else []:
        full = os.path.join(dl, d)
        if not (os.path.isdir(full) and d.startswith("Rina")):
            continue
        got = sorted(glob.glob(os.path.join(full, "*.webp")))
        if got:
            return got[0]
    return None


def main():
    setup_stdout()
    src = find_sample()
    if not src:
        print("找不到样本图。先跑 node tools/e2e.js 生成一张，或把图片路径作为参数传入。")
        return 1

    raw = open(src, "rb").read()
    print(f"样本：{os.path.basename(src)}")
    print(f"  服务器原始字节：{len(raw):,} 字节  ({len(raw)/1024:.0f} KB)")
    im = Image.open(io.BytesIO(raw))
    print(f"  格式={im.format}  模式={im.mode}  尺寸={im.size[0]}x{im.size[1]}")
    print(f"  首帧 WebP 编码方式：{'有损 (VP8)' if im.info.get('lossy', True) is not False else '无损 (VP8L)'}")
    rgb = im.convert("RGB")
    ref = np.asarray(rgb)
    px = ref.shape[0] * ref.shape[1]
    print(f"  像素总数：{px:,}    → 平均每像素 {len(raw)/px:.3f} 字节")

    print("\n" + "=" * 78)
    print("把这张图转成 JPEG 的结果（输入已是有损 webp，所以这是第二代损失）")
    print("=" * 78)
    print(f"{'质量':>6} {'文件大小':>12} {'相对原图':>10} {'PSNR(dB)':>10} {'SSIM':>8} {'最大像素误差':>12}  主观")
    print("-" * 78)

    print(f"{'原始webp':>6} {len(raw):>10,}B {'100%':>10} {'—':>10} {'1.0000':>8} {'0':>12}  基准")

    rows = []
    for q in (75, 85, 92, 95, 98, 100):
        buf = io.BytesIO()
        rgb.save(buf, "JPEG", quality=q, subsampling=0, optimize=True)
        data = buf.getvalue()
        back = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
        p = psnr(ref, back)
        s = ssim(ref, back)
        mx = int(np.abs(ref.astype(int) - back.astype(int)).max())
        ratio = len(data) / len(raw)
        if p > 45:
            verdict = "肉眼不可分辨"
        elif p > 40:
            verdict = "极难分辨"
        elif p > 35:
            verdict = "细看可见"
        else:
            verdict = "可察觉"
        print(f"{q:>6} {len(data):>10,}B {ratio*100:>9.0f}% {p:>10.2f} {s:>8.4f} {mx:>12}  {verdict}")
        rows.append((q, len(data), p, s))

    # 无损对照
    buf = io.BytesIO()
    rgb.save(buf, "PNG", optimize=True)
    print(f"{'PNG':>6} {len(buf.getvalue()):>10,}B {len(buf.getvalue())/len(raw)*100:>9.0f}% {'inf':>10} {'1.0000':>8} {'0':>12}  完全无损")

    print("\n结论要点：")
    small = [r for r in rows if r[1] < len(raw)]
    if small:
        best_small = max(small, key=lambda r: r[2])
        print(f"  · 能同时「更小」的档位只有 {[r[0] for r in small]}；其中画质最好的质量 {best_small[0]}："
              f"{best_small[1]:,}B（原图的 {best_small[1]/len(raw)*100:.0f}%），PSNR {best_small[2]:.2f}dB、SSIM {best_small[3]:.4f}")
        print("    → 也就是说：要变小就必须掉画质，两者不可兼得（这张图的 webp 本身就压得很小）")
    print("  · 无论哪个质量档，都是「在已有损失之上再加一层损失」，画质只会变差、不会变好。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
