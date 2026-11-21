"""Bridge two local Docker bind mounts to VA's per-user command socket."""

import argparse
import concurrent.futures
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path


REQUEST_LIMIT = 8192
RESPONSE_LIMIT = 34 * 1024 * 1024
PLATFORMS = ("astrbot", "openclaw")
COMMANDS = {"route", "present", "input", "status", "say", "perform", "selfie", "view", "actions"}


def read_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid bridge file")
        return stream.read(limit + 1)


def atomic_write(path, data):
    temporary = path.with_name("." + uuid.uuid4().hex)
    with os.fdopen(
        os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
    ) as stream:
        stream.write(data)
    os.replace(temporary, path)


def error(message):
    return json.dumps({"ok": False, "error": {"message": message}}, ensure_ascii=False).encode()


def reply(path, platform, command):
    stem = path.name.removesuffix(".request")
    response_path = path.with_name(stem + ".response")
    try:
        data = read_file(path, REQUEST_LIMIT)
        request = json.loads(data)
        if len(data) > REQUEST_LIMIT or not isinstance(request, dict) or request.get("op") not in COMMANDS:
            raise ValueError("Invalid bridge request")
        request["platform"] = platform
        result = subprocess.run([command, "bridge"], input=json.dumps(request, ensure_ascii=False).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=86, check=False)
        data = result.stdout if 0 < len(result.stdout) <= RESPONSE_LIMIT else error("VA 未返回有效结果。")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        data = error("VA 容器桥接请求失败。")
    try:
        if path.exists():
            atomic_write(response_path, data)
    finally:
        path.unlink(missing_ok=True)


def host(folder, command):
    pending = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            for path, task in tuple(pending):
                if task.done():
                    pending.remove((path, task))
            if len(pending) < 4:
                claimed = {path for path, _ in pending}
                for platform in PLATFORMS:
                    directory = folder / platform
                    directory.mkdir(exist_ok=True, parents=True, mode=0o700)
                    for path in directory.glob("*.request"):
                        if len(pending) == 4:
                            break
                        if path not in claimed and re.fullmatch(r"[0-9a-f]{32}\.request", path.name):
                            pending.add((path, pool.submit(reply, path, platform, command)))
            time.sleep(0.12)


def client(folder):
    data = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    if not data or len(data) > REQUEST_LIMIT:
        sys.stdout.buffer.write(error("VA 桥接请求为空或过大。"))
        return
    stem = uuid.uuid4().hex
    request = folder / (stem + ".request")
    response = folder / (stem + ".response")
    atomic_write(request, data)
    try:
        deadline = time.monotonic() + 84
        while time.monotonic() < deadline:
            try:
                sys.stdout.buffer.write(read_file(response, RESPONSE_LIMIT))
                return
            except FileNotFoundError:
                time.sleep(0.1)
        sys.stdout.buffer.write(error("等待本机 VA 容器桥接超时。"))
    finally:
        request.unlink(missing_ok=True)
        response.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("host", "client"))
    parser.add_argument("folder", type=Path)
    parser.add_argument("operation", nargs="?", choices=("bridge",))
    parser.add_argument("--command", default="va")
    args = parser.parse_args()
    if args.mode == "host":
        host(args.folder, args.command)
    else:
        client(args.folder)
