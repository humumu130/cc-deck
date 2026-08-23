// 终端按键注入器：AttachConsole + CONIN$ + WriteConsoleInput（不抢焦点）
// 用法: inject.exe <pid> <text> [noenter]   正常文本+回车（noenter=只打字不提交）
//       inject.exe <pid> --esc              发送一个 Esc 键（打断生成）
// 退出码: 0=成功 1=attach 失败（进程不存在/无控制台） 2=写失败 3=参数错 4=CONIN$ 打开失败 5=内部异常
// 关键教训：本进程做过 FreeConsole/AttachConsole 切换后绝不能再碰 System.Console——
// 句柄状态不一致会引爆 .NET 运行时且连异常都打印不出来（实测"无法打印异常字符串"崩溃），
// 因此结果只用退出码表达，不输出任何文字。
// 编译: csc -nologo -out:inject.exe inject.cs（由 relay/src/injector.ts 自动完成）
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class CcrInject
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
    // 必须显式 W 版：默认会解析到 A 版（按 1 字节 ANSI 解释字符），中文被截断成低字节
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] rec, uint n, out uint written);

    // 字段全部用 Blittable 类型（int 代 BOOL、ushort 代 WCHAR）：bool/char 是非 Blittable，
    // marshaler 会按 DllImport 的 CharSet（默认 Ansi）转换整个结构体导致布局错乱
    // （实测：EventType 读回 0、中文被截断成低字节、'复'(U+590D) 变回车）。Blittable 直传指针，零转换。
    [StructLayout(LayoutKind.Sequential)]
    struct KEY_EVENT_RECORD
    {
        public int bKeyDown;       // Win32 BOOL
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public ushort UnicodeChar; // WCHAR
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    const ushort KEY_EVENT = 1;

    static INPUT_RECORD Key(char c, bool down, ushort vk)
    {
        var r = new INPUT_RECORD();
        r.EventType = KEY_EVENT;
        r.KeyEvent.bKeyDown = down ? 1 : 0;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.UnicodeChar = c;
        r.KeyEvent.wVirtualKeyCode = vk;
        return r;
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) return 3;
            uint pid;
            if (!uint.TryParse(args[0], out pid)) return 3;
            bool esc = args[1] == "--esc";
            string text = args[1];
            bool enter = !esc && (args.Length < 3 || args[2] != "noenter");

            FreeConsole(); // 一个进程只能挂一个控制台，先脱离自己的
            if (!AttachConsole(pid)) return 1;

            IntPtr h = CreateFileW("CONIN$", 0xC0000000, 0x00000003, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ|WRITE, share rw, OPEN_EXISTING
            if (h == IntPtr.Zero || h == new IntPtr(-1)) { FreeConsole(); return 4; }

            var recs = new List<INPUT_RECORD>();
            if (esc)
            {
                recs.Add(Key((char)0x1B, true, 0x1B));
                recs.Add(Key((char)0x1B, false, 0x1B));
            }
            else foreach (char c in text)
            {
                recs.Add(Key(c, true, 0));
                recs.Add(Key(c, false, 0));
            }
            if (enter)
            {
                recs.Add(Key('\r', true, 0x0D));
                recs.Add(Key('\r', false, 0x0D));
            }

            uint written;
            if (!WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out written))
            {
                FreeConsole();
                return 2;
            }
            FreeConsole();
            return 0;
        }
        catch
        {
            return 5;
        }
    }
}
