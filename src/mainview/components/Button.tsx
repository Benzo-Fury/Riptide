import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Tip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	/** An icon set before the label. */
	icon?: ReactNode;
	children?: ReactNode;
}

/** The one button shape: a 6px rectangle with one fill. Primary is bronze. */
export function Button({ variant = "secondary", icon, children, className = "", type = "button", ...rest }: ButtonProps) {
	return (
		<button type={type} className={`btn btn--${variant} ${className}`} {...rest}>
			{icon}
			{children && <span>{children}</span>}
		</button>
	);
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** Read by screen readers and shown as the tip. */
	label: string;
	children: ReactNode;
	active?: boolean;
}

/** A square icon-only button with an accessible label; the label also shows as a tip. */
export function IconButton({ label, children, active, className = "", type = "button", ...rest }: IconButtonProps) {
	return (
		<Tip text={label}>
			<button type={type} aria-label={label} className={`icon-btn ${active ? "is-active" : ""} ${className}`} {...rest}>
				{children}
			</button>
		</Tip>
	);
}
