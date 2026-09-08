// Type-ahead folder picker used by tab rows, bookmark rows and answers.


export function folderOptionLabel(path: string[]): string {
  const depth = path.length - 1;
  return depth === 0 ? path[0]! : `${"   ".repeat(depth)}└ ${path[path.length - 1]}`;
}


/**
 * Closing every tab in a window closes the window — and the browser, if it was
 * the last one. Spawn a New Tab in any window we're about to empty first.
 */

export function toggleFolderSelect(
  anchor: HTMLElement,
  folders: { id: string; path: string[] }[],
  onPick: (folderId: string) => void
): void {
  const existing = anchor.nextElementSibling;
  if (existing?.classList.contains("inline-select")) {
    existing.remove();
    return;
  }
  document.querySelectorAll(".inline-select").forEach((el) => el.remove());

  const box = document.createElement("div");
  box.className = "inline-select folder-picker";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "picker-input";
  input.placeholder = "Type to filter folders…";

  const list = document.createElement("div");
  list.className = "picker-list";

  let active = 0;
  let matches: { id: string; path: string[] }[] = [];
  const render = () => {
    const query = input.value.trim().toLowerCase();
    matches = folders.filter((f) => f.path.join(" / ").toLowerCase().includes(query));
    list.replaceChildren();
    matches.forEach((folder, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "picker-item" + (i === active ? " active" : "");
      // filtered matches show the full path so hits deep in the tree stay legible
      item.textContent = query ? folder.path.join(" / ") : folderOptionLabel(folder.path);
      item.title = folder.path.join(" / ");
      item.addEventListener("click", () => {
        box.remove();
        onPick(folder.id);
      });
      list.appendChild(item);
    });
    if (!matches.length) {
      const none = document.createElement("div");
      none.className = "empty-note";
      none.textContent = "No folders match.";
      list.appendChild(none);
    }
  };
  render();

  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      box.remove();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[active];
      if (pick) {
        box.remove();
        onPick(pick.id);
      }
    }
  });

  box.append(input, list);
  anchor.after(box);
  input.focus();
}

