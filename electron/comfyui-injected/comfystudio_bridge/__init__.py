"""
Velorn Bridge for ComfyUI.

This package installs a small ComfyUI frontend extension. It does not add
generation nodes; it only adds a "Send to Velorn" action to the ComfyUI
interface so the current graph can be exported as API JSON and posted back to
the embedded Velorn app. (Package folder keeps the legacy comfystudio_bridge
name so installs update in place.)
"""

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
