import { useId } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useAmDialog } from './amModal.jsx';

/** Bottom sheet (mobile). Used for chat / notes panels on small screens. */
export function AmSheet({ open, onClose, title, children, height = 'min(86dvh, 720px)' }) {
  const ref = useAmDialog(open, onClose);
  const titleId = useId();
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-50 flex items-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="glass-strong relative flex w-full min-h-0 flex-col overflow-hidden rounded-t-3xl pb-[env(safe-area-inset-bottom)] shadow-glow"
            style={{ height, maxHeight: 'calc(100dvh - env(safe-area-inset-top))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 34 }}
          >
            <motion.div
              className="shrink-0 touch-none"
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 120) onClose?.();
              }}
            >
              <div className="flex items-center justify-between px-5 pt-3 pb-2">
                <span className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-white/20" aria-hidden />
                <h2 id={titleId} className="pt-2 text-base font-semibold text-white">
                  {title}
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={`Close ${title}`}
                  className="mt-1 grid size-9 place-items-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
            </motion.div>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
