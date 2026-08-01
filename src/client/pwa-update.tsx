import { useRegisterSW } from "virtual:pwa-register/react";
import { RefreshCw, X } from "lucide-react";

export function PwaUpdate() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <aside className="pwa-update" aria-live="polite" aria-label="echovale update available">
      <span>A new version of echovale is ready.</span>
      <div className="pwa-update-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void updateServiceWorker()}
        >
          <RefreshCw aria-hidden="true" size={15} />
          Update
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Dismiss update"
          onClick={() => setNeedRefresh(false)}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </aside>
  );
}
