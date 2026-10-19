"""Print what `appwrite push table` would change, applying nothing that needs approval.

Usage: python3 -I scripts/appwrite-table-plan.py <log> appwrite push table --all --config-file <file>

The deploy's `push table --force` deletes and recreates a column or index whose type or orders
changed, and deletes columns, indexes, tables and databases missing from the config, without
asking. Appwrite CLI 28.7.0 has no dry run, and without a terminal it stops at its first
question, so it shows only the first table with a change. So the deploy first runs it without
--force in a pseudo-terminal that answers "n" to every yes/no question: the CLI then prints
every change and applies none that needs approval (new tables and their columns are created
without a question). It never sends "y" or Enter, so a question that defaults to yes is never
accepted. The log, without colour codes, is what the deploy greps (environments-and-deploys.md).
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

log, command = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    # 50 rows by 200 columns, so the prompts' help line and the change tables are never wrapped.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    os.execvp(command[0], command)

ansi = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\r")
out, answered, deadline = b"", 0, time.time() + 600
while True:
    if time.time() > deadline:
        # The child leads its own session (pty.fork), so this also stops anything it started.
        os.killpg(pid, signal.SIGKILL)
        out += b"\nplan: timed out after 600 s\n"
        break
    if select.select([fd], [], [], 0.5)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        # The CLI's prompts query the terminal and wait for its answer.
        if b"\x1b]11;?" in chunk:  # background colour
            os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if b"\x1b[6n" in chunk:  # cursor position
            os.write(fd, b"\x1b[1;1R")
    elif b"y Yes \xe2\x80\xa2 n No" in ansi.sub(b"", out[answered:]):
        # Quiet for half a second with a yes/no question on screen: answer it "n".
        os.write(fd, b"n")
        answered = len(out)

_, status = os.waitpid(pid, 0)
text = ansi.sub(b"", out).decode("utf-8", "replace")
with open(log, "w", encoding="utf-8") as file:
    file.write(text)
print(text)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
