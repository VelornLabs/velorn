# Velorn runtime guard — exports no nodes.
#
# This package exists solely so ComfyUI's custom-node loader picks up our
# sibling `prestartup_script.py`. All the real work happens there.
#
# Directory name note: kept as `_comfystudio_stdout_guard` for backwards
# compatibility with existing user installs. The guard now covers both the
# Windows pipe-flush EINVAL bug and the child-process console-window flash
# — see prestartup_script.py for details.

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
