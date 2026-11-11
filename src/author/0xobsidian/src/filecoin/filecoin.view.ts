// filecoin.view.ts — Obsidian ItemView for author-scoped Filecoin storage
import { ItemView, WorkspaceLeaf, Notice, setIcon, Menu } from "obsidian";
import type { IMainController } from "../main.ctrlr.js";

export const FILECOIN_VIEW_TYPE = "oxo-filecoin-storage";

// ── Inline styles (injected once) ────────────────────────────────
const VIEW_CSS = `
.oxo-storage-group { margin-bottom: 0.5rem; }
.oxo-group-header {
  display: flex; align-items: center; gap: 0.3rem;
  padding: 0.2rem 0.4rem;
  border-radius: 4px; cursor: pointer;
  font-weight: 600; font-size: 0.85rem;
}
.oxo-group-header:hover { background: var(--background-modifier-hover); }
.oxo-chevron { display: inline-flex; transition: transform 0.15s; }
.oxo-chevron-open { transform: rotate(90deg); }
.oxo-kind-icon { display: inline-flex; }
.oxo-group-label { flex: 1; }
.oxo-group-body { margin-left: 1.2rem; }
.oxo-group-body.oxo-collapsed { display: none; }
.oxo-storage-row {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.15rem 0.4rem; font-size: 0.8rem;
}
.oxo-storage-row:hover { background: var(--background-modifier-hover); border-radius: 3px; }
.oxo-owner { font-family: var(--font-monospace); font-size: 0.75rem; min-width: 7em; }
.oxo-cid-link { font-family: var(--font-monospace); font-size: 0.75rem; color: var(--link-color); text-decoration: none; }
.oxo-cid-link:hover { text-decoration: underline; }
.oxo-info { font-size: 0.7rem; color: var(--text-muted); flex: 1; text-align: right; }
.oxo-more { display: inline-flex; cursor: pointer; opacity: 0.5; }
.oxo-more:hover { opacity: 1; }
.oxo-muted { color: var(--text-muted); font-size: 0.8rem; }
`;

interface StorageItem {
  pieceCid: string | undefined;
  pieceId: bigint;
  rootCid: string | null;
  kind: string | null;
  owners: string[];
  dataSetId: string;
  provider: string | undefined;
}

export class FilecoinStorageView extends ItemView {
  private ctrlr: IMainController;
  private data: StorageItem[] = [];
  private loading = false;

  constructor(leaf: WorkspaceLeaf, ctrlr: IMainController) {
    super(leaf);
    this.ctrlr = ctrlr;
  }

  getViewType(): string {
    return FILECOIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Filecoin Storage";
  }

  getIcon(): string {
    return "hard-drive";
  }

  async onOpen() {
    // Inject styles once
    if (!document.getElementById("oxo-filecoin-view-css")) {
      const style = document.createElement("style");
      style.id = "oxo-filecoin-view-css";
      style.textContent = VIEW_CSS;
      document.head.appendChild(style);
    }
    this.render();
    await this.refresh();
  }

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    this.render();

    try {
      const filecoin = this.ctrlr.storage;
      if (!filecoin) {
        this.data = [];
        this.render();
        return;
      }

      // Storage is listed for the active author's EOA, which signs the uploads.
      // The author Safe is the item's author, not the Filecoin piece's owner.
      const identity = this.ctrlr.user?.eoa || "";
      if (!identity) {
        new Notice("No active 0xObsidian user — cannot load Filecoin storage");
        this.loading = false;
        this.render();
        return;
      }

      this.data = await filecoin.listStorageFor(identity);
    } catch (err: any) {
      console.error("[filecoin-view] Failed to load storage:", err);
      new Notice(`Failed to load Filecoin storage: ${err.message}`);
    }

    this.loading = false;
    this.render();
  }

  private render() {
    const el = this.containerEl.children[1] as HTMLElement;
    el.empty();

    el.createEl("h3", { text: "Filecoin Storage" });

    if (this.loading) {
      el.createSpan({ text: "Loading…" });
      return;
    }

    // Group by kind
    const groups = new Map<string, StorageItem[]>();
    const unattributed: StorageItem[] = [];

    for (const item of this.data) {
      const key = item.kind || "unattributed";
      if (key === "unattributed") {
        unattributed.push(item);
      } else {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
      }
    }

    // Render each group as a collapsible section
    for (const [kind, items] of groups) {
      this.renderGroup(el, kind, items, true);
    }

    if (unattributed.length > 0) {
      this.renderGroup(el, "Unattributed", unattributed, false);
    }

    if (this.data.length === 0) {
      el.createSpan({
        text: "No pieces found for this identity. Content must be tagged with attributedTo metadata to appear here.",
        cls: "oxo-muted",
      });
    }
  }

  private renderGroup(
    el: HTMLElement,
    label: string,
    items: StorageItem[],
    collapsible: boolean,
  ) {
    const container = el.createDiv({ cls: "oxo-storage-group" });

    // Header row with icon + count
    const header = container.createDiv({ cls: "oxo-group-header" });
    if (collapsible) {
      header.classList.add("oxo-collapsible");
      header.addEventListener("click", () => {
        body.classList.toggle("oxo-collapsed");
        header.querySelector(".oxo-chevron")?.classList.toggle("oxo-chevron-open");
      });
    }

    const chevron = header.createSpan({ cls: "oxo-chevron" });
    setIcon(chevron, "chevron-right");

    const icon = header.createSpan({ cls: "oxo-kind-icon" });
    const iconName = label === "config" ? "file-json"
      : label === "assets" ? "image"
      : label === "templates" ? "file-text"
      : "file";
    setIcon(icon, iconName);

    header.createSpan({
      text: `${label} (${items.length})`,
      cls: "oxo-group-label",
    });

    // Body
    const body = container.createDiv({ cls: "oxo-group-body" });
    if (collapsible) body.classList.add("oxo-collapsed");

    for (const item of items) {
      this.renderRow(body, item);
    }
  }

  private renderRow(container: HTMLElement, item: StorageItem) {
    const row = container.createDiv({ cls: "oxo-storage-row" });

    // Publicaton address (the "other" owner — not the author)
    const otherOwner = item.owners.find(
      (o) => o !== this.ctrlr.user?.eoa,
    );
    const ownerLabel = otherOwner
      ? `${otherOwner.slice(0, 6)}…${otherOwner.slice(-4)}`
      : "—";
    row.createSpan({ text: ownerLabel, cls: "oxo-owner" });

    // Root CID with gateway link
    if (item.rootCid) {
      const cid = `${item.rootCid.slice(0, 8)}…`;
      const link = row.createEl("a", {
        text: cid,
        href: `https://ipfs.transport-union.dev/ipfs/${item.rootCid}`,
        cls: "oxo-cid-link",
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    } else {
      row.createSpan({ text: "—", cls: "oxo-muted" });
    }

    // Info
    const info = row.createSpan({
      text: `ds:${item.dataSetId}  p:${item.provider?.slice(0, 6) || "—"}`,
      cls: "oxo-info",
    });

    // Context menu (⋯)
    const more = row.createSpan({ cls: "oxo-more" });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = new Menu();
      // menu.addItem((i) => i.setTitle("Delete piece").setIcon("trash").onClick(() => this.deletePiece(item)));
      menu.addItem((i) =>
        i
          .setTitle("Copy CID")
          .setIcon("copy")
          .onClick(() => {
            navigator.clipboard.writeText(item.rootCid || item.pieceCid || "");
            new Notice("CID copied");
          }),
      );
      menu.showAtMouseEvent(e);
    });
  }
}