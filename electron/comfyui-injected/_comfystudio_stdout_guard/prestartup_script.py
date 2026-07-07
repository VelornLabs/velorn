# Velorn runtime guard (prestartup hook).
#
# This single file installs narrow, non-invasive patches to the Python runtime
# that ComfyUI is launched from. All exist to paper over Windows-specific
# rough edges that would otherwise surface as visible artifacts (crashes,
# flashing console windows) to end users.
#
# Historical note: the directory is still called `_comfystudio_stdout_guard`
# because an earlier pass only did the stdout patch. We kept the name to
# avoid leaving orphaned directories in users' custom_nodes/ folders. The
# patches are now:
#
#   1. stdout/stderr flush EINVAL swallow. Applied at two layers because
#      the original class-level patch on `io.TextIOWrapper.flush` silently
#      fails on CPython — `_io.TextIOWrapper` is an immutable C type that
#      raises `TypeError: cannot set 'flush' attribute of immutable type`
#      if you try to replace a method on it. Instead we:
#        (a) override the `flush` attribute on the current `sys.stdout` /
#            `sys.stderr` instances directly (TextIOWrapper instances
#            permit per-instance attribute assignment even though the
#            class itself is immutable);
#        (b) import ComfyUI's own `app.logger` module and patch
#            `LogInterceptor.flush` (a pure-Python subclass of
#            TextIOWrapper and therefore mutable).
#      Fixes the "emoji print crashes ComfyUI" bug class (`💾 CACHE HIT`,
#      `📝 Punctuation / Truecase`, `[SAM3 Video] CACHE MISS …`, etc.).
#
#   2. `subprocess.Popen.__init__` — on Windows, inject `CREATE_NO_WINDOW`
#      into the creationflags so that child processes spawned by custom
#      nodes (pip checks, git calls, ffmpeg probes, model downloaders, etc.)
#      don't pop a console window. Fixes the "three or four terminals flash
#      when ComfyUI boots" UX problem.
#
# Each patch is guarded so legitimate behaviors still work:
#   * EINVAL is the only errno we swallow; disk-full / permission-denied /
#     other I/O errors still raise normally.
#   * We only add CREATE_NO_WINDOW if the caller hasn't asked for
#     CREATE_NEW_CONSOLE (a node author explicitly wanting a console still
#     gets one) and hasn't already specified CREATE_NO_WINDOW themselves.
#
# Design lesson (2026-04): an earlier version of this script tried to wrap
# `sys.stdout` in a transparent proxy object. That deadlocked against
# wandb's `console_capture.write_with_callbacks`, which installs itself by
# snapshotting `orig_write = sys.stdout.write` and then setting
# `sys.stdout.write = wrapper`. Against our proxy both sides ended up
# calling each other forever and every `print()` blew the recursion limit.
# The current instance-attribute approach deliberately avoids introducing
# a new object; we only swap a bound method on the same TextIOWrapper
# instance, which wandb's wrapping handles correctly.
#
# Removal: delete this directory. Velorn will recreate it on the next
# launch unless you disable the guard in the launcher settings.

import io
import sys


# ---------------------------------------------------------------------------
# Patch 1 — swallow Windows pipe flush EINVAL.
#
# The failing chain is:
#
#   print("💾 ...")
#       → wandb.console_capture.write_with_callbacks
#       → colorama.ansitowin32.write_plain_text
#       → comfyui-manager.sync_write
#       → original_stdout.flush()        (no try/except)
#       → LogInterceptor.flush() → super().flush()
#       → TextIOWrapper.flush() → BufferedWriter.flush()
#       → WriteFile(pipe_fd, bytes)
#       → Windows returns ERROR_INVALID_PARAMETER → OSError errno=22
#
# The bytes have already reached the kernel pipe buffer when WriteFile
# rejects them. Swallowing the status is safe and lets the workflow
# continue.
# ---------------------------------------------------------------------------

_EINVAL = 22
_patch_notes = []  # breadcrumb trail for the install banner at the bottom


def _swallow_einval(callable_, *args, **kwargs):
    """Run `callable_` and swallow only `OSError` with `errno == EINVAL`."""
    try:
        return callable_(*args, **kwargs)
    except OSError as exc:
        if getattr(exc, "errno", None) != _EINVAL:
            raise
        return None


# --- Layer (a): instance-level flush override on sys.stdout / sys.stderr ----
#
# `_io.TextIOWrapper` (the C class) refuses class-level method assignment
# with `TypeError: cannot set 'flush' attribute of immutable type`, but each
# *instance* of it accepts arbitrary attribute assignment via its __dict__.
# Shadowing `flush` on the instance means every `sys.stdout.flush()` call
# (and every `captured_ref.flush()` call where the reference points to the
# same instance) now goes through our safe wrapper.
#
# Why this works against wandb: wandb wraps `write`, not `flush`, so our
# flush override is invisible to it. And we don't introduce a new object,
# so the wandb-proxy recursion trap of the previous design is gone.

def _install_instance_flush_guard(stream, label):
    if stream is None:
        return
    try:
        original_flush = stream.flush

        def _safe_flush():
            return _swallow_einval(original_flush)

        stream.flush = _safe_flush
        _patch_notes.append("%s.flush" % label)
    except Exception as exc:
        _patch_notes.append("%s.flush FAILED: %r" % (label, exc))


_install_instance_flush_guard(getattr(sys, "stdout", None), "sys.stdout")
_install_instance_flush_guard(getattr(sys, "stderr", None), "sys.stderr")


# --- Layer (b): patch ComfyUI's own LogInterceptor.flush --------------------
#
# After ComfyUI's `setup_logger()` runs (later in boot), `sys.stdout` is
# replaced with a `LogInterceptor` instance — and anything that captures
# `sys.stdout` after that point holds a direct reference to the new
# `LogInterceptor`, bypassing our layer-(a) instance flush guard (which was
# set on the old TextIOWrapper). Fortunately `LogInterceptor` is a regular
# Python subclass of `io.TextIOWrapper`, so we can patch its `flush` method
# at the class level with no C-type restrictions.
#
# We import `app.logger` eagerly here. The module has no import-time side
# effects (`setup_logger` is a function called explicitly later), so this
# is safe even though we're running during prestartup.

try:
    from app import logger as _comfyui_logger  # noqa: E402  (import at runtime intentionally)

    _LogInterceptor = getattr(_comfyui_logger, "LogInterceptor", None)
    if _LogInterceptor is not None:
        _original_li_flush = _LogInterceptor.flush

        def _guarded_li_flush(self):
            return _swallow_einval(_original_li_flush, self)

        _LogInterceptor.flush = _guarded_li_flush
        _patch_notes.append("LogInterceptor.flush")
    else:
        _patch_notes.append("LogInterceptor missing from app.logger")
except Exception as exc:
    _patch_notes.append("app.logger patch FAILED: %r" % (exc,))


# --- Layer (c) removed intentionally ----------------------------------------
#
# An earlier version of this script tried `io.TextIOWrapper.flush = ...` as
# a belt-and-suspenders fallback. CPython always rejects that with
# `TypeError: cannot set 'flush' attribute of immutable type`, so the line
# was a silent no-op that only served to anchor the (wrong) mental model
# that our guard was active. Layers (a) and (b) cover every real crash
# path; we don't need the fallback.


# ---------------------------------------------------------------------------
# Patch 2 — suppress orphan console windows from custom-node subprocesses.
#
# On Windows, `subprocess.Popen(...)` with no explicit `creationflags` opens
# a new console window every time the child is a console application (pip,
# git, ffmpeg, curl, powershell, etc.). Custom nodes rarely remember to pass
# `creationflags=subprocess.CREATE_NO_WINDOW`, so when ComfyUI boots and
# imports a few dozen custom nodes, three or four cmd windows flash on
# screen before disappearing. Looks like malware to a non-technical user.
#
# We patch `subprocess.Popen.__init__` to OR `CREATE_NO_WINDOW` into any
# `creationflags` arg on Windows, unless the caller explicitly asked for
# `CREATE_NEW_CONSOLE` (in which case we respect their intent).
#
# Scope caveat: this only covers Python-level subprocess calls. Calls made
# via ctypes / os.system / direct CreateProcessW are not affected. In
# practice those are rare enough in ComfyUI's custom-node ecosystem that
# the flash storm is reduced to roughly zero once this is active.
# ---------------------------------------------------------------------------

if sys.platform == "win32":
    try:
        import subprocess

        # Constants from <winbase.h>. Python exposes these on `subprocess` but
        # defining them inline keeps this file self-contained and avoids any
        # attribute-missing surprise on older Pythons.
        _CREATE_NEW_CONSOLE = 0x00000010
        _CREATE_NO_WINDOW = 0x08000000

        _original_popen_init = subprocess.Popen.__init__

        def _guarded_popen_init(self, *args, **kwargs):
            # The caller may have passed creationflags positionally or by
            # keyword. Popen's signature has creationflags at position 12
            # (after the core stdio / cwd / env / startupinfo args), but
            # callers almost always use kwargs for anything beyond the
            # command list. We only touch kwargs; positional callers who
            # went that deep almost certainly know what they're doing and
            # shouldn't be surprised.
            cflags = kwargs.get("creationflags", 0) or 0
            if not (cflags & _CREATE_NEW_CONSOLE) and not (cflags & _CREATE_NO_WINDOW):
                kwargs["creationflags"] = cflags | _CREATE_NO_WINDOW
            # We also need a STARTUPINFO with wShowWindow=SW_HIDE to suppress
            # a window in some edge cases where CREATE_NO_WINDOW alone isn't
            # respected (e.g. the child inherits a console and calls
            # ShowWindow). Only inject if the caller didn't supply their own.
            if kwargs.get("startupinfo") is None:
                try:
                    si = subprocess.STARTUPINFO()
                    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    si.wShowWindow = 0  # SW_HIDE
                    kwargs["startupinfo"] = si
                except Exception:
                    # If STARTUPINFO isn't available for some reason, we
                    # still have CREATE_NO_WINDOW from above — that covers
                    # the 99% case.
                    pass
            return _original_popen_init(self, *args, **kwargs)

        subprocess.Popen.__init__ = _guarded_popen_init
        _patch_notes.append("subprocess.Popen no-console")
    except Exception as exc:
        _patch_notes.append("subprocess patch FAILED: %r" % (exc,))


# ---------------------------------------------------------------------------
# Announce ourselves on the raw byte stream so even a fully-broken stdout
# wrapper stack can't trip the flush bug while we're trying to log. Plain
# ASCII on purpose. The list of successful patches is included so that when
# something goes wrong we can tell at a glance from the ComfyUI startup log
# which layers are live.
# ---------------------------------------------------------------------------

try:
    _banner = ("[Velorn runtime guard] installed: " + ", ".join(_patch_notes) + "\n").encode("ascii", "replace")
    sys.__stdout__.buffer.write(_banner)
    sys.__stdout__.buffer.flush()
except Exception:
    # Swallow anything here — the guard succeeding is vastly more important
    # than the banner printing, and we don't want a quirky embedded Python
    # without a usable __stdout__ to take us down.
    pass

# Unreferenced `io` import is kept so that adding a layer-(c) style patch
# later doesn't require re-adding the import. Cheap insurance.
_ = io
