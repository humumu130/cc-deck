#!/usr/bin/env python3
"""wt-lock —— worktree/harvest 锁原子获取器（W-ORG-DEFECTS 返工② P0-②，B 档攻防 1101）。

病灶：leader-dispatch/leader-harvest 的「预检读 + 覆盖写」两步非原子——双实例同刻并发
同 slug 时双双过预检、双双落锁、双双放行（B 档实测直推 dispatch POST 零拒派）。

协议（与 relay/src/dispatch-lock.ts acquire/claim 同源，恰一胜保证同款）：
  O_EXCL 独占建锁；EEXIST → 活锁判负 / 陈锁（过期/坏 JSON/pid 已死）→ 临时文件 +
  os.replace 原子替换 + 回读校验 created_at/pid——双竞争者同刻接管陈锁时盘上只剩
  最后 replace 者，回读不符者判负。任何竞态下恰一胜。

用法（退出码即裁决，stdout 供人读/上级脚本拼接）：
  wt-lock.py wt acquire <锁路径> --slug S [--window-ms N]
      无主/陈锁接管 → WIN(0)；他人活锁（含异 slug 哨兵/他人 dispatch_id）→ LOSE(3)。
      注：bash 侧只做「哨兵锁」获取（无 dispatch_id）；归属补写=relay 认领边 claim。
  wt-lock.py wt verdict <锁路径>
      活锁 → "held <slug> <剩余min>min"；陈锁/无锁 → "stale"（预检只读面）。
  wt-lock.py hlock acquire <锁路径> --pid P [--dispatch-id D] [--window-ms N]
      harvest 实例锁：pid 存活且锁龄<窗 → LOSE(3)；否则原子接管 → WIN(0)。
  wt-lock.py hlock verdict <锁路径>   # 同 verdict 语义（pid 视角）
"""
import argparse
import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time

WIN, LOSE = 0, 3


def now_ms() -> int:
    return int(time.time() * 1000)


def window_ms(args) -> int:
    v = os.environ.get("CCR_WT_LOCK_WINDOW_MS", "")
    try:
        if int(v) > 0:
            return int(v)
    except ValueError:
        pass
    return getattr(args, "window_ms", None) or 7_200_000


def read_lock(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def wt_active(d, now: int, win: int) -> bool:
    if not isinstance(d, dict):
        return False
    exp = d.get("expires_at", 0)
    return isinstance(exp, (int, float)) and exp > now


def hlock_active(d, now: int, win: int) -> bool:
    if not isinstance(d, dict):
        return False
    ts = d.get("ts", 0)
    if not (isinstance(ts, (int, float)) and now - ts < win):
        return False
    pid = d.get("pid")
    if not isinstance(pid, int):
        return False
    try:
        os.kill(pid, 0)  # 存活探测（信号 0 零副作用）
        return True
    except (ProcessLookupError, PermissionError):
        return False  # PermissionError=他人用户进程存活；macOS 同用户场景此处罕见，保守判活更安全
    except OSError:
        return False


def write_tmp_lock(tmp_dir: str, body: dict) -> str:
    tmp = os.path.join(tmp_dir, "lock")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(body, f, indent=2)
        f.write("\n")
    return tmp


def excl_link_create(path: str, body: dict) -> bool:
    """内容先行+link 原子上位：目标路径要么不存在、要么是完整 JSON——杜绝
    「O_EXCL 建空文件→写内容」窗口期被并发读者读成半写态/空态误判陈锁。"""
    tmp_dir = tempfile.mkdtemp(prefix="wtlock-")
    try:
        tmp = write_tmp_lock(tmp_dir, body)
        try:
            os.link(tmp, path)  # 原子：path 已存在即 FileExistsError；成功即内容完整
            return True
        except FileExistsError:
            return False
        except Exception:
            raise
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def atomic_takeover(path: str, body: dict) -> int:
    """陈锁接管：temp+os.replace+回读校验——恰一胜（败者回读到赢者）。"""
    tmp_dir = tempfile.mkdtemp(prefix="wtlock-")
    tmp = os.path.join(tmp_dir, "lock")
    try:
        write_tmp_lock(tmp_dir, body)
        os.replace(tmp, path)  # 原子替换：盘上只剩最后 replace 者
        back = read_lock(path)
        if back == body:  # 回读=自己 → 我赢了这轮接管
            print(f"WIN takeover {path} slug={body.get('slug') or body.get('pid')}")
            return WIN
        print(f"LOSE takeover-raced {path} winner={json.dumps(back)[:160]}")
        return LOSE
    except Exception as e:  # fs 异常一律 fail-closed（B 档坏锁 fail-open 教训）
        print(f"LOSE fs-error {path}: {e}")
        return LOSE
    finally:
        try:
            import shutil

            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def mtx_acquire(path: str):
    """跨进程互斥（flock）：临界区=读锁+建锁/接管全程——「replace+回读校验」不是线性化
    CAS（早期竞争者可在末位 replace 落盘前完成自证=假胜，8 并发实测偶发双胜），flock 把
    check-act-verify 变真临界区。mutex 文件放系统 tmpdir 按 realpath 哈希键控（不污
    worktree git status）；flock 随进程消亡自动释放（无陈 mutex）。返回打开的句柄，调用
    方 close 即释放。"""
    realpath = os.path.realpath(path)
    h = hashlib.sha256(realpath.encode("utf-8")).hexdigest()[:16]
    f = open(os.path.join(tempfile.gettempdir(), f"wtlock-mtx-{h}"), "a+")
    fcntl.flock(f.fileno(), fcntl.LOCK_EX)  # 阻塞式：临界区毫秒级，8 并发排队可忽略
    return f


def cmd_wt_acquire(args) -> int:
    path, now, win = args.path, now_ms(), window_ms(args)
    body = {"slug": args.slug, "created_at": now, "expires_at": now + win}
    mtx = None
    try:
        mtx = mtx_acquire(path)
        if excl_link_create(path, body):  # 内容先行+link 原子上位（无半写窗口）
            print(f"WIN create {path} slug={args.slug}")
            return WIN
        cur = read_lock(path)
        if wt_active(cur, now, win):
            print(f"LOSE held {path} slug={cur.get('slug', '?')} exp_in={round((cur['expires_at'] - now) / 60000)}min")
            return LOSE
        return atomic_takeover(path, body)  # 陈锁/坏锁：原子接管
    except Exception as e:
        print(f"LOSE fs-error {path}: {e}")
        return LOSE
    finally:
        if mtx:
            mtx.close()  # 释放 flock


def cmd_wt_verdict(args) -> int:
    path, now, win = args.path, now_ms(), window_ms(args)
    cur = read_lock(path)
    if wt_active(cur, now, win):
        print(f"held {cur.get('slug', '?')} {round((cur['expires_at'] - now) / 60000)}min")
    else:
        print("stale")
    return 0


def cmd_hlock_acquire(args) -> int:
    path, now, win = args.path, now_ms(), window_ms(args)
    body = {"pid": args.pid, "ts": now, **({"dispatch_id": args.dispatch_id} if args.dispatch_id else {})}
    mtx = None
    try:
        mtx = mtx_acquire(path)  # 与 wt 同款跨进程临界区（harvest 无 relay 串行化点，全靠此处）
        if excl_link_create(path, body):  # 内容先行+link 原子上位（无半写窗口）
            print(f"WIN create {path} pid={args.pid}")
            return WIN
        cur = read_lock(path)
        if hlock_active(cur, now, win):
            held_pid = cur.get("pid", "?")
            held_min = round((now - cur.get("ts", 0)) / 60000)
            print(f"LOSE held {path} pid={held_pid} age={held_min}min（收割实例在跑——等其收尾再试，撞车事故源：1101 定性 P0）")
            return LOSE
        return atomic_takeover(path, body)  # pid 已死/过期=陈锁：原子接管
    except Exception as e:
        print(f"LOSE fs-error {path}: {e}")
        return LOSE
    finally:
        if mtx:
            mtx.close()  # 释放 flock


def cmd_hlock_verdict(args) -> int:
    path, now, win = args.path, now_ms(), window_ms(args)
    cur = read_lock(path)
    if hlock_active(cur, now, win):
        print(f"held pid={cur.get('pid', '?')} age={round((now - cur.get('ts', 0)) / 60000)}min")
    else:
        print("stale")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="wt-lock")
    sub = ap.add_subparsers(dest="mode", required=True)
    p_wt = sub.add_parser("wt")
    p_wt_sub = p_wt.add_subparsers(dest="op", required=True)
    q = p_wt_sub.add_parser("acquire")
    q.add_argument("path")
    q.add_argument("--slug", required=True)
    q.add_argument("--window-ms", type=int, default=None)
    q.set_defaults(fn=cmd_wt_acquire)
    qv = p_wt_sub.add_parser("verdict")
    qv.add_argument("path")
    qv.add_argument("--window-ms", type=int, default=None)
    qv.set_defaults(fn=cmd_wt_verdict)
    p_h = sub.add_parser("hlock")
    p_h_sub = p_h.add_subparsers(dest="op", required=True)
    h = p_h_sub.add_parser("acquire")
    h.add_argument("path")
    h.add_argument("--pid", type=int, required=True)
    h.add_argument("--dispatch-id", default=None)
    h.add_argument("--window-ms", type=int, default=None)
    h.set_defaults(fn=cmd_hlock_acquire)
    hv = p_h_sub.add_parser("verdict")
    hv.add_argument("path")
    hv.add_argument("--window-ms", type=int, default=None)
    hv.set_defaults(fn=cmd_hlock_verdict)
    args = ap.parse_args()
    if not hasattr(args, "fn"):
        ap.error("需要子命令")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
