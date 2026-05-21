import { app } from "../../../scripts/app.js";

const BRIDGE_SOURCE = "comfystudio-comfyui-bridge";
const BRIDGE_VERSION = "0.1.0";

function getBridgeContainer() {
  let container = document.getElementById("comfystudio-bridge-container");
  if (container) return container;

  container = document.createElement("div");
  container.id = "comfystudio-bridge-container";
  container.style.position = "fixed";
  container.style.right = "12px";
  container.style.bottom = "12px";
  container.style.zIndex = "9999";
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.gap = "8px";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);
  return container;
}

function setStatus(text, tone = "idle") {
  const status = document.getElementById("comfystudio-bridge-status");
  if (!status) return;
  status.textContent = text || "";
  status.style.display = text ? "inline-flex" : "none";
  status.style.color = tone === "error" ? "#fecaca" : tone === "ok" ? "#bbf7d0" : "#d1d5db";
  status.style.borderColor = tone === "error" ? "rgba(248, 113, 113, 0.45)" : tone === "ok" ? "rgba(52, 211, 153, 0.45)" : "rgba(148, 163, 184, 0.35)";
  status.style.background = tone === "error" ? "rgba(127, 29, 29, 0.88)" : tone === "ok" ? "rgba(6, 78, 59, 0.88)" : "rgba(15, 23, 42, 0.88)";
}

async function getCurrentApiWorkflow() {
  if (typeof app.graphToPrompt !== "function") {
    throw new Error("ComfyUI graph export API is not available yet.");
  }

  const exported = await app.graphToPrompt();
  const workflow = exported?.output || exported?.prompt || null;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("Could not export the current graph as API workflow JSON.");
  }

  return {
    workflow,
    visualWorkflow: exported?.workflow || null,
  };
}

function postWorkflowToComfyStudio(payload) {
  const message = {
    source: BRIDGE_SOURCE,
    type: "api-workflow",
    version: BRIDGE_VERSION,
    name: `ComfyUI graph ${new Date().toLocaleTimeString()}`,
    ...payload,
  };

  let sent = false;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
    sent = true;
  }
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(message, "*");
    sent = true;
  }
  return sent;
}

function createBridgeButton() {
  const container = getBridgeContainer();
  if (document.getElementById("comfystudio-bridge-send")) return;

  const status = document.createElement("span");
  status.id = "comfystudio-bridge-status";
  status.style.display = "none";
  status.style.alignItems = "center";
  status.style.maxWidth = "320px";
  status.style.border = "1px solid rgba(148, 163, 184, 0.35)";
  status.style.borderRadius = "8px";
  status.style.padding = "6px 8px";
  status.style.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";
  status.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.35)";
  status.style.pointerEvents = "auto";
  container.appendChild(status);

  const button = document.createElement("button");
  button.id = "comfystudio-bridge-send";
  button.type = "button";
  button.textContent = "Send to ComfyStudio";
  button.title = "Export this graph as API JSON and send it back to ComfyStudio.";
  button.style.border = "1px solid rgba(59, 130, 246, 0.65)";
  button.style.borderRadius = "8px";
  button.style.background = "rgba(15, 23, 42, 0.92)";
  button.style.color = "#bfdbfe";
  button.style.padding = "8px 10px";
  button.style.font = "600 12px system-ui, -apple-system, Segoe UI, sans-serif";
  button.style.cursor = "pointer";
  button.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.35)";
  button.style.pointerEvents = "auto";

  button.addEventListener("mouseenter", () => {
    button.style.background = "rgba(30, 41, 59, 0.96)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "rgba(15, 23, 42, 0.92)";
  });
  button.addEventListener("click", async () => {
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Sending...";
    setStatus("", "idle");
    try {
      const exported = await getCurrentApiWorkflow();
      const sent = postWorkflowToComfyStudio(exported);
      setStatus(sent ? "Sent to ComfyStudio." : "Open ComfyUI inside ComfyStudio to send directly.", sent ? "ok" : "error");
      window.setTimeout(() => setStatus("", "idle"), sent ? 2500 : 6500);
    } catch (error) {
      setStatus(error?.message || "Could not send workflow to ComfyStudio.", "error");
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  });

  container.appendChild(button);
}

app.registerExtension({
  name: "ComfyStudio.Bridge",
  setup() {
    createBridgeButton();
  },
});
