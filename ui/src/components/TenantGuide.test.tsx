// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantGuide } from "./TenantGuide";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TenantGuide", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(node: ReactElement) {
    const root = createRoot(container);
    act(() => {
      root.render(node);
    });
    return { container, root };
  }

  function clickNav(label: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".vg-nav-item")).find(
      (el) => el.textContent?.includes(label),
    );
    if (!button) throw new Error(`nav item "${label}" not found`);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders the dialog when open", () => {
    render(<TenantGuide open onClose={() => {}} userRole="operator" companyName="Acme" />);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("renders nothing when closed", () => {
    render(<TenantGuide open={false} onClose={() => {}} userRole="operator" />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the signed-in role label in the header", () => {
    render(<TenantGuide open onClose={() => {}} userRole="viewer" />);
    expect(container.querySelector(".vg-brand-sub")?.textContent).toContain("Viewer");
  });

  it("badges an Operator+ section for a Viewer without hiding it", () => {
    render(<TenantGuide open onClose={() => {}} userRole="viewer" />);
    // Navigate from Welcome (no role gate) to the operator-gated Inbox section.
    clickNav("Inbox");
    const badge = container.querySelector(".vg-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Operator+");
    // Viewer ranks below Operator, so the badge is dimmed — but the content still renders.
    expect(badge?.classList.contains("vg-badge-dim")).toBe(true);
    expect(container.querySelector(".vg-prose")?.textContent ?? "").not.toBe("");
  });
});
