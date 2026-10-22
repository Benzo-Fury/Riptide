import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { SHUTTER } from "../lib/constants";
import { tideBand, useTide } from "../lib/tide";
import { useReducedMotion } from "../lib/hooks";
import { IconButton } from "./Button";

interface DialogProps {
	open: boolean;
	title: string;
	onClose: () => void;
	children: ReactNode;
	/** Buttons along the bottom edge, right-aligned. */
	footer?: ReactNode;
	/** Width in pixels. */
	width?: number;
	/** Shown at the left of the footer (a status, an error). */
	footerNote?: ReactNode;
}

/**
 * A modal dialog: the tide rises over it from the bottom edge, its footer, body and head
 * surfacing in turn as the water passes them, and drains away as it closes. It closes on Escape
 * or a click on the scrim, and keeps focus inside while open.
 */
export function Dialog({ open, title, onClose, children, footer, footerNote, width = 560 }: DialogProps) {
	const panel = useRef<HTMLDivElement>(null);
	// Read through a ref: callers pass a new function every render, which mustn't re-run the effect
	const close = useRef(onClose);
	close.current = onClose;

	// Escape closes; focus moves into the dialog once, when it opens, and back when it closes
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close.current();
			}
		};
		window.addEventListener("keydown", onKey, true);
		const t = setTimeout(() => {
			const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, select, button.btn--primary");
			first?.focus();
		}, 60);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			clearTimeout(t);
			previous?.focus?.();
		};
	}, [open]);

	return (
		<AnimatePresence>
			{open && (
				<motion.div className="dialog-layer" {...SHUTTER.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
					<DialogPanel panel={panel} title={title} onClose={onClose} footer={footer} footerNote={footerNote} width={width}>
						{children}
					</DialogPanel>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

interface DialogPanelProps extends Omit<DialogProps, "open"> {
	panel: RefObject<HTMLDivElement | null>;
}

/** The dialog itself; mounted only while open, so the tide measures it fresh each time. */
function DialogPanel({ panel, title, onClose, children, footer, footerNote, width }: DialogPanelProps) {
	const reduced = useReducedMotion();
	const { clip, shade } = useTide(panel, { reduced, duration: 0.56 });
	const foot = !!(footer || footerNote);
	return (
		<div ref={panel} role="dialog" aria-modal="true" aria-label={title} className="dialog" style={{ width }}>
			<motion.div className="float-shade" aria-hidden="true" {...(reduced ? SHUTTER.still : { style: { opacity: shade } })} />
			<motion.div className="dialog__clip" style={{ clipPath: clip }} {...(reduced ? SHUTTER.still : {})}>
				<div className="dialog__inner">
					<motion.header className="dialog__head" {...tideBand(foot ? 2 : 1, reduced)}>
						<h2 className="dialog__title">{title}</h2>
						<IconButton label="Close" onClick={onClose}>
							<X size={16} strokeWidth={1.5} />
						</IconButton>
					</motion.header>
					<motion.div className="dialog__body" {...tideBand(foot ? 1 : 0, reduced)}>
						{children}
					</motion.div>
					{foot && (
						<motion.footer className="dialog__foot" {...tideBand(0, reduced)}>
							<div className="dialog__note">{footerNote}</div>
							<div className="dialog__actions">{footer}</div>
						</motion.footer>
					)}
				</div>
			</motion.div>
		</div>
	);
}
