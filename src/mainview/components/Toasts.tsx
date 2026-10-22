import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { EASE_OUT } from "../lib/constants";

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
	id: number;
	message: string;
	tone: ToastTone;
	action?: { label: string; onSelect: () => void };
}

let toasts: ToastItem[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((fn) => fn());

/** Shows a short message in the bottom-left corner. Errors stay longer. */
export function toast(message: string, tone: ToastTone = "info", action?: ToastItem["action"]): void {
	const id = nextId++;
	toasts = [...toasts.slice(-3), { id, message, tone, action }];
	emit();
	setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
}

/** Shows an error from a failed call. */
export function toastError(e: unknown): void {
	toast(e instanceof Error ? e.message : String(e), "error");
}

function dismiss(id: number): void {
	toasts = toasts.filter((t) => t.id !== id);
	emit();
}

/** Where toasts appear. Render once, near the root. */
export function ToastHost() {
	const items = useSyncExternalStore(
		(fn) => {
			subscribers.add(fn);
			return () => subscribers.delete(fn);
		},
		() => toasts,
	);
	return (
		<div className="toasts" role="status" aria-live="polite">
			<AnimatePresence initial={false}>
				{items.map((t) => (
					<motion.div
						key={t.id}
						layout
						className={`toast toast--${t.tone}`}
						initial={{ opacity: 0, y: 16, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: EASE_OUT, opacity: { duration: 0.18, ease: "linear" } } }}
						exit={{ opacity: 0, x: -24, transition: { duration: 0.2, ease: EASE_OUT } }}
					>
						<span className="toast__msg">{t.message}</span>
						{t.action && (
							<button
								className="toast__action"
								onClick={() => {
									t.action!.onSelect();
									dismiss(t.id);
								}}
							>
								{t.action.label}
							</button>
						)}
						<button className="toast__close" aria-label="Dismiss" data-tip="Dismiss" onClick={() => dismiss(t.id)}>
							<X size={14} strokeWidth={1.5} />
						</button>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}
