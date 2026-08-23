// Spike: 向另一进程的控制台注入按键（AttachConsole + WriteConsoleInput）
// 用法: inject.exe <pid> <text> [noenter]
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class CcrInject
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] rec, uint n, out uint written);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);

    [StructLayout(LayoutKind.Sequential)]
    struct KEY_EVENT_RECORD
    {
        public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
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
        r.KeyEvent.bKeyDown = down;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.UnicodeChar = c;
        r.KeyEvent.wVirtualKeyCode = vk;
        return r;
    }

    static int Fail(string what, int code)
    {
        Console.Error.WriteLine(what + " err=" + Marshal.GetLastWin32Error());
        return code;
    }

    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: inject <pid> <text> [noenter]"); return 3; }
        uint pid = uint.Parse(args[0]);
        string text = args[1];
        bool enter = args.Length < 3 || args[2] != "noenter";

        FreeConsole(); // 一个进程只能挂一个控制台，先脱离自己的
        if (!AttachConsole(pid)) return Fail("attach", 1);

        IntPtr h = CreateFileW("CONIN$", 0xC0000000, 0x00000003, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ|WRITE, share rw, OPEN_EXISTING
        if (h == IntPtr.Zero || h == new IntPtr(-1)) { FreeConsole(); return Fail("conin", 4); }

        var recs = new List<INPUT_RECORD>();
        foreach (char c in text)
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
        if (!WriteConsoleInput(h, recs.ToArray(), (uint)recs.Count, out written))
        {
            FreeConsole();
            return Fail("write", 2);
        }
        FreeConsole();
        Console.WriteLine("ok records=" + written);
        return 0;
    }
}
