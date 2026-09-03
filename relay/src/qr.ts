// 终端 ASCII 二维码（--qr / --daemon 后的 /cc-deck 命令展示用）
import qrcode from "qrcode-terminal";

export function printQr(text: string, label: string): void {
  console.log(`\n${label}`);
  qrcode.generate(text, { small: true });
}
