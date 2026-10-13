"use client";

// Accessible dialog using the browser's <dialog> element (focus is moved into
// it and kept there; Escape closes it).

import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-white p-0 text-tx shadow-lg backdrop:bg-black/30"
    >
      {open && (
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn l" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
