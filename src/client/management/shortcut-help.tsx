import { AlertTriangle, Keyboard, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Kbd } from "./shared";
import "./shortcut-help.css";

const shortcuts = [
  ["J / →", "Next article"],
  ["K / ←", "Previous article"],
  ["Space", "Scroll article page"],
  ["U", "Mark active article unread"],
  ["S", "Star or unstar article"],
  ["C", "Copy active article URL"],
  ["O", "Open active article source"],
  ["W", "Toggle feed or full content"],
  ["M", "Show, hide, or create article summary"],
  ["T", "Toggle article translation"],
  ["R", "Refresh current feed or folder"],
  ["Shift R", "Refresh every feed"],
  ["[", "Decrease article text size"],
  ["]", "Increase article text size"],
  ["1", "Magazine view"],
  ["2", "Expanded view"],
  ["?", "Show shortcut reference"],
] as const;

export function ShortcutReference({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`shortcut-reference${compact ? " is-compact" : ""}`}>
      <dl>
        {shortcuts.map(([key, label]) => (
          <div key={key}>
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <div className="shortcut-groups">
        <h3>Go to</h3>
        <dl>
          <div>
            <dt>
              <Kbd>g u</Kbd>
            </dt>
            <dd>Unread</dd>
          </div>
          <div>
            <dt>
              <Kbd>g s</Kbd>
            </dt>
            <dd>Starred</dd>
          </div>
          <div>
            <dt>
              <Kbd>g a</Kbd>
            </dt>
            <dd>All articles</dd>
          </div>
          <div>
            <dt>
              <Kbd>g f</Kbd>
            </dt>
            <dd>Feeds &amp; status</dd>
          </div>
          <div>
            <dt>
              <Kbd>g r</Kbd>
            </dt>
            <dd>Rules</dd>
          </div>
          <div>
            <dt>
              <Kbd>g ,</Kbd>
            </dt>
            <dd>Settings</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export function ShortcutHelp({
  open,
  enabled,
  onClose,
}: {
  open: boolean;
  enabled: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="shortcut-dialog"
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="shortcut-dialog-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="dialog-icon" aria-hidden="true">
            <Keyboard size={18} />
          </span>
          <h2 id="shortcut-dialog-title">Keyboard shortcuts</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close shortcuts"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      {!enabled ? (
        <div className="shortcuts-disabled">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>Single-key shortcuts are disabled in Settings. Tab navigation still works.</span>
        </div>
      ) : null}
      <ShortcutReference />
      <div className="dialog-footer">
        <p>Shortcuts pause while focus is in a form field.</p>
        <button className="primary-button" type="button" onClick={() => ref.current?.close()}>
          Close reference
        </button>
      </div>
    </dialog>
  );
}

export default ShortcutHelp;
